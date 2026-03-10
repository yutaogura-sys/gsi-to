/**
 * GSI vector tile layer → DXF layer mapping
 * ASCII-only layer names for maximum DXF compatibility
 */

const ACI = {
  RED: 1, YELLOW: 2, GREEN: 3, CYAN: 4, BLUE: 5,
  MAGENTA: 6, WHITE: 7, GRAY: 8, BROWN: 24,
  ORANGE: 30, LIGHT_GREEN: 83, LIGHT_BLUE: 151,
};

// Simple mode: draft drawings (building/road/structure only, monochrome)
const SIMPLE_LAYER_MAP = {
  building:    { dxf: 'BUILDING',   color: ACI.WHITE, geometry: 'polygon' },
  road:        { dxf: 'ROAD',       color: ACI.GRAY,  geometry: 'line' },
  structurea:  { dxf: 'STRUCTURE',  color: ACI.WHITE, geometry: 'polygon' },
  structurel:  { dxf: 'STRUCTURE',  color: ACI.WHITE, geometry: 'line' },
  structure:   { dxf: 'STRUCTURE',  color: ACI.WHITE, geometry: 'line' },
};

// Full mode: all layers with color
const FULL_LAYER_MAP = {
  building:    { dxf: 'BUILDING',   color: ACI.YELLOW,     geometry: 'polygon' },
  road:        { dxf: 'ROAD',       color: ACI.WHITE,      geometry: 'line' },
  railway:     { dxf: 'RAILWAY',    color: ACI.MAGENTA,    geometry: 'line' },
  contour:     { dxf: 'CONTOUR',    color: ACI.BROWN,      geometry: 'line' },
  river:       { dxf: 'RIVER',      color: ACI.CYAN,       geometry: 'line' },
  waterarea:   { dxf: 'WATER',      color: ACI.CYAN,       geometry: 'polygon' },
  lake:        { dxf: 'LAKE',       color: ACI.CYAN,       geometry: 'polygon' },
  coastline:   { dxf: 'COAST',      color: ACI.LIGHT_BLUE, geometry: 'line' },
  boundary:    { dxf: 'BOUNDARY',   color: ACI.BLUE,       geometry: 'line' },
  label:       { dxf: 'LABEL',      color: ACI.WHITE,      geometry: 'point' },
  symbol:      { dxf: 'SYMBOL',     color: ACI.GREEN,      geometry: 'point' },
  elevation:   { dxf: 'ELEVATION',  color: ACI.GREEN,      geometry: 'point' },
  transp:      { dxf: 'TRANSPORT',  color: ACI.MAGENTA,    geometry: 'point' },
  landforml:   { dxf: 'LANDFORM_L', color: ACI.BROWN,      geometry: 'line' },
  landforma:   { dxf: 'LANDFORM_A', color: ACI.BROWN,      geometry: 'polygon' },
  structurea:  { dxf: 'STRUCT_A',   color: ACI.GRAY,       geometry: 'polygon' },
  structurel:  { dxf: 'STRUCT_L',   color: ACI.GRAY,       geometry: 'line' },
  structure:   { dxf: 'STRUCT_L',   color: ACI.GRAY,       geometry: 'line' },
  searoute:    { dxf: 'SEAROUTE',   color: ACI.LIGHT_BLUE, geometry: 'line' },
};

const DEFAULT_LAYER = { color: ACI.WHITE, geometry: 'line' };

export function getLayerConfig(gsiLayerName, mode = 'simple') {
  const map = mode === 'simple' ? SIMPLE_LAYER_MAP : FULL_LAYER_MAP;
  if (map[gsiLayerName]) return map[gsiLayerName];
  if (mode === 'simple') return null;
  return { dxf: gsiLayerName.toUpperCase(), ...DEFAULT_LAYER };
}
