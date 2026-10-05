# Hamburg – terrain tiles over Mapterhorn's

Terrarium WebP tiles (512 px, zoom 15) in Mapterhorn's own format, read by
the pipeline's terrain sampler (`scripts/lib/terrain.mjs`) before it asks
tiles.mapterhorn.com for the same tile. They cover the 2 km squares of the
Hamburg DGM1 that Mapterhorn's import lacks (the city centre, Ottensen,
Hammerbrook, Rothenburgsort, Wilhelmsburg – mapterhorn/mapterhorn#131),
where Mapterhorn's tiles come from a 30 m surface model, 3–20 m above the
ground. Every tile touching one of the 20 missing squares is here – 202
tiles, 27 MB – built from the DGM1 where it has data and carrying
Mapterhorn's own pixels elsewhere. Checked against the DGM10 heights the
city's stops used to carry: all 1528 within 2 m, 96 % within 0.5 m.

- Source: Digitales Höhenmodell Hamburg DGM1, release 2016-01-04, 2 km
  squares of ASCII XYZ in EPSG:25832 (`dgm1_2x2km_xyz_hh_2016-01-04`) –
  the same file Mapterhorn's Hamburg tiles are built from.
- License: Datenlizenz Deutschland – Namensnennung – Version 2.0
  (dl-de/by-2-0). Attribution: © Freie und Hansestadt Hamburg, Landesbetrieb
  Geoinformation und Vermessung (LGV).
- Built once, by hand, with
  `node scripts/build-terrain-patch.mjs --city hamburg`. A
  rerun writes the same bytes; once Mapterhorn closes the holes it writes
  nothing and names the tiles that can go.
