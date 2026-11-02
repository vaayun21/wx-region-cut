# wx-region-cut

Cropped, re-quantised copies of ECMWF open data and DWD ICON for 20 S to 45 N, 20 E to 155 E; personal non-commercial use.

Every release holds one small compressed file per weather field and a
`manifest.json` that lists the files, their sizes and their hashes. The
`latest` release points at the newest published run of each model.

## Running locally

```
node cutter/run.mjs --model ecmwf --out ./out --dry-run
node cutter/run.mjs --model ecmwf --out ./out
```

The scheduled GitHub Actions workflow does the same work in the cloud.

## Attribution

Copyright (c) 2026 European Centre for Medium-Range Weather Forecasts (ECMWF). Source: www.ecmwf.int. Licence: Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/. ECMWF does not accept any liability for any error or omission in the data, their availability, or for any loss or damage arising from their use. Contains modified ECMWF open data: cropped to 20 S to 45 N, 20 E to 155 E and re-quantised.

Source: Deutscher Wetterdienst (DWD). Licence: CC BY 4.0 / GeoNutzV. Data basis: Deutscher Wetterdienst, gridded data cropped, regridded to a regular grid and re-quantised.

## Licence

The code is provided for personal, non-commercial use.
