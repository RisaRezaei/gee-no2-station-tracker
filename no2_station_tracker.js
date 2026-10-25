/**
 * NO2 Station Tracker
 * -------------------
 * Tropospheric NO2 time series from Sentinel-5P TROPOMI at air-quality
 * monitoring stations, built in the Google Earth Engine Code Editor.
 *
 * What it does
 *   1. Builds a daily (or monthly) mean NO2 series at each station.
 *   2. Charts all stations together in the Console.
 *   3. Maps the period-mean NO2 field around the stations.
 *   4. Exports a tidy CSV (station, date, NO2) to Google Drive.
 *
 * How to run
 *   Paste this file into https://code.earthengine.google.com, edit the
 *   CONFIG block and press Run. Start the export from the Tasks tab.
 *
 * Author: Parisa Abbasalizadehrezaei · https://risarezaei.github.io
 * License: MIT
 */

// =============================== CONFIG ===================================
var CONFIG = {
  // Stations: name + [longitude, latitude]. Replace with your own, or set
  // STATIONS_ASSET to a point FeatureCollection asset instead.
  stations: [
    {name: 'Example station (Queens, NY)', lon: -73.817694, lat: 40.739264}
    // , {name: 'Second station', lon: 0.0, lat: 0.0}
  ],
  STATIONS_ASSET: null,          // e.g. 'users/you/stations'
  STATION_NAME_FIELD: 'name',    // property holding the station name

  startDate: '2019-01-01',       // TROPOMI data start mid-2018
  endDate:   null,               // null = up to today

  // 'OFFL' = offline (consistent archive, recommended for trends)
  // 'NRTI' = near-real-time (latest days, less consistent)
  product: 'OFFL',

  // Temporal aggregation of the series: 'day' or 'month'
  step: 'month',

  // Buffer around each station in metres (0 = single pixel at the point)
  bufferMeters: 2000,

  // Export settings
  exportToDrive: true,
  driveFolder: 'earthengine',
  filePrefix: 'no2_station_timeseries'
};
// ==========================================================================

var BAND = 'tropospheric_NO2_column_number_density';
var SCALE = 1113.2;  // native L3 grid (~0.01 degrees)

// ---- Stations ----------------------------------------------------------
var stations = CONFIG.STATIONS_ASSET
  ? ee.FeatureCollection(CONFIG.STATIONS_ASSET)
  : ee.FeatureCollection(CONFIG.stations.map(function (s) {
      return ee.Feature(ee.Geometry.Point([s.lon, s.lat]), {name: s.name});
    }));

var nameField = CONFIG.STATIONS_ASSET ? CONFIG.STATION_NAME_FIELD : 'name';
var regions = CONFIG.bufferMeters > 0
  ? stations.map(function (f) { return f.buffer(CONFIG.bufferMeters); })
  : stations;

// ---- NO2 collection ----------------------------------------------------
var start = ee.Date(CONFIG.startDate);
var end = CONFIG.endDate ? ee.Date(CONFIG.endDate) : ee.Date(Date.now());

var no2 = ee.ImageCollection('COPERNICUS/S5P/' + CONFIG.product + '/L3_NO2')
  .select(BAND)
  .filterDate(start, end)
  .filterBounds(regions.geometry());

// Aggregate the many overpasses into one mean image per day / month.
var nSteps = end.difference(start, CONFIG.step).floor();
var series = ee.ImageCollection(
  ee.List.sequence(0, nSteps.subtract(1)).map(function (i) {
    var t0 = start.advance(i, CONFIG.step);
    var t1 = t0.advance(1, CONFIG.step);
    var subset = no2.filterDate(t0, t1);
    // Empty steps get a fully masked placeholder and are filtered out below.
    var img = ee.Image(ee.Algorithms.If(subset.size().gt(0), subset.mean(),
        ee.Image.constant(0).rename(BAND).updateMask(0)));
    return img
      .multiply(1e6)                 // mol/m2 -> umol/m2 (easier to read)
      .rename('NO2_umol_m2')
      .set('system:time_start', t0.millis())
      .set('n_images', subset.size());
  })
).filter(ee.Filter.gt('n_images', 0));

// ---- Chart -------------------------------------------------------------
var chart = ui.Chart.image.seriesByRegion({
  imageCollection: series,
  regions: regions,
  reducer: ee.Reducer.mean(),
  band: 'NO2_umol_m2',
  scale: SCALE,
  xProperty: 'system:time_start',
  seriesProperty: nameField
}).setOptions({
  title: 'Tropospheric NO2 at stations (' + CONFIG.step + 'ly mean, Sentinel-5P ' + CONFIG.product + ')',
  vAxis: {title: 'NO2 column (umol/m2)'},
  hAxis: {title: 'Date'},
  lineWidth: 1.5,
  pointSize: 2
});
print(chart);

// ---- Map ---------------------------------------------------------------
var meanField = series.mean();
Map.centerObject(stations, 9);
Map.addLayer(meanField, {
  min: 0, max: 150,
  palette: ['0d1b2a', '1b4965', '5fa8d3', 'cae9ff', 'f9c74f', 'f3722c', 'd00000']
}, 'Mean tropospheric NO2 (umol/m2)');
Map.addLayer(regions, {color: 'ffffff'}, 'Stations');

// ---- Export a tidy table: one row per station and time step ------------
var table = series.map(function (img) {
  var date = img.date().format(CONFIG.step === 'day' ? 'YYYY-MM-dd' : 'YYYY-MM');
  return img.reduceRegions({
    collection: regions,
    reducer: ee.Reducer.mean().setOutputs(['NO2_umol_m2']),
    scale: SCALE
  }).map(function (f) {
    return ee.Feature(null, {
      station: f.get(nameField),
      date: date,
      NO2_umol_m2: f.get('NO2_umol_m2'),
      n_overpasses: img.get('n_images')
    });
  });
}).flatten();

print('First rows of the export table', table.limit(5));

if (CONFIG.exportToDrive) {
  Export.table.toDrive({
    collection: table,
    description: CONFIG.filePrefix,
    folder: CONFIG.driveFolder,
    fileNamePrefix: CONFIG.filePrefix,
    fileFormat: 'CSV',
    selectors: ['station', 'date', 'NO2_umol_m2', 'n_overpasses']
  });
}
