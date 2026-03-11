# ORCID + JCR Report (SCIE/SSCI)

Aplicacion web para:

1. Cargar un catalogo de revistas WoS/JCR (CSV/TXT/XLS/XLSX/PDF).
2. Guardar el catalogo en el navegador (`localStorage`) para no pedirlo de nuevo en usos posteriores.
3. Ingresar ORCID (ID o URL) y consultar publicaciones publicas desde ORCID.
4. Validar revistas en JCR solo para SCIE/SSCI y mostrar:
   - Impact Factor
   - Mejor cuartil
   - Area(s) del mejor cuartil
   - Todos los cuartiles
5. Exportar reporte a CSV y JSON.
6. Mostrar resumen estadistico del investigador.

## Estructura

- App para GitHub Pages: `docs/`
- Version Node/Express (opcional local): `server.js` + `public/`

## Uso en GitHub Pages

1. Subir repositorio a GitHub.
2. En GitHub: `Settings` -> `Pages`.
3. En `Build and deployment`, seleccionar:
   - `Source`: `Deploy from a branch`
   - `Branch`: `main`
   - `Folder`: `/docs`
4. Guardar. El sitio quedara publicado en `https://<usuario>.github.io/<repo>/`.

## Uso local rapido (version Pages)

```bash
cd docs
python3 -m http.server 8080
```

Abrir `http://localhost:8080`.

## Flujo de uso

1. Cargar catalogo JCR/WoS (una sola vez por navegador).
2. Ingresar ORCID (por ejemplo `https://orcid.org/0000-0003-0969-5139`).
3. Generar reporte.
4. Exportar CSV o JSON.

## Notas

- La API publica ORCID utilizada es: `https://pub.orcid.org/v3.0/{orcid}/works`.
- La validacion JCR se hace contra el catalogo cargado localmente.
- `ESCI` no cuenta como validacion cuando se filtra SCIE/SSCI.
- Para PDF tipo `JCR IMPACT FACTOR LIST`, el indice viene como `SCIE/SSCI (no especificado en catalogo PDF)` porque ese formato no incluye separacion explicita SCIE vs SSCI ni area de categoria.
