// Attribution and hygiene text used by the cutter. The wording is fixed by the
// release format contract; do not paraphrase it in generated files.

export const NEUTRAL_DESCRIPTION =
  'Cropped, re-quantised copies of ECMWF open data and DWD ICON for 20 S to 45 N, 20 E to 155 E; personal non-commercial use.'

export const ECMWF_MODEL_TITLE = 'ECMWF IFS 0.25'
export const ICON_MODEL_TITLE = 'ICON 13 km (DWD)'

export function ecmwfAttribution(year = new Date().getUTCFullYear()) {
  return (
    `Copyright (c) ${year} European Centre for Medium-Range Weather Forecasts (ECMWF). ` +
    'Source: www.ecmwf.int. Licence: Creative Commons Attribution 4.0 International (CC BY 4.0), ' +
    'https://creativecommons.org/licenses/by/4.0/. ECMWF does not accept any liability for any error ' +
    'or omission in the data, their availability, or for any loss or damage arising from their use. ' +
    'Contains modified ECMWF open data: cropped to 20 S to 45 N, 20 E to 155 E and re-quantised.'
  )
}

export const DWD_ATTRIBUTION =
  'Source: Deutscher Wetterdienst (DWD). Licence: CC BY 4.0 / GeoNutzV. Data basis: ' +
  'Deutscher Wetterdienst, gridded data cropped, regridded to a regular grid and re-quantised.'
