# pi-j-space

Adaptación **1:1 en funcionalidad** de [J-Space-Cognition-Suite-V3.6](https://github.com/Tiger3807861189/J-Space-Cognition-Suite-V3.6) como extensión para [pi-coding-agent](https://github.com/earendil-works/pi-mono).

La suite original era un skill (SKILL.md + 9 módulos + 3 referencias) con un controlador opcional
de Python (`jspace.py`). Aquí vive igual, empaquetado como extensión de pi:

| Original | Esta extensión |
|---|---|
| Skill: `SKILL.md` + `modules/*` (9) + `references/*` (3) | `skills/j-space/` — mismo contenido, registrado vía `resources_discover` |
| `scripts/jspace.py` (seam / note / ship / resume) | Tool **`jspace`** — mismo script Python, invocado con `pi.exec` en el cwd del workspace |
| `scripts/verify_suite.py` | Comando **`/jspace-verify`** + script intacto |
| `tests/test_jspace.py` + CI | Idénticos (rutas adaptadas al layout) |

La lógica del controlador no se reimplementó: es el mismo `jspace.py` (stdlib, sin red, escribe
solo `.jspace/`), así que el comportamiento y el formato del ledger son literalmente los mismos.

## Uso

Dentro de este repo:

```bash
pi -e ./extension.ts
```

Para que cargue siempre (auto-descubrimiento), enlaza o copia la extensión:

```bash
ln -s "$PWD/extension.ts" ~/.pi/agent/extensions/j-space.ts
```

O instálala como paquete pi (git) en otros proyectos:

```bash
pi install git:github.com/0x360x36/pi-j-space
```

Requisitos: `python3` en el PATH (para el controlador y la verificación) y `npm install` aquí
dentro (solo para tipado/empaquetado; la extensión en sí no requiere dependencias en runtime).

## El tool `jspace`

Un tool llamable por el modelo — el equivalente exacto de la CLI del controlador:

```text
jspace action seam                      # el ledger, y qué ha cambiado desde la última vez
jspace action note goal "..." next "..."   # abrir el ledger (goal + next obligatorios la 1ª vez)
jspace action note core "name — fact" [core_slot 1|2]   # hub entry, con o sin swap
jspace action note check "..." by "..." # checkpoint verificado con cobertura declarada
jspace action note open "..." settled_by "..."  # pregunta abierta con test que la cerraría
jspace action note close N check "..." by "..."   # cerrar pregunta N (requiere checkpoint)
jspace action ship file PATH            # escanear texto saliente por fugas del registro interno
jspace action resume                    # premisa + ledger completo + invariantes, tras un gap
```

- `ship` también acepta `text` en lugar de `file` — el equivalente de `ship -` (stdin).
- El ledger se guarda en `.jspace/` del workspace del task (el cwd de la sesión), nunca en el repo.
- Exit 0 = hizo lo pedido; 2 = no pudo (el texto de rechazo dice por qué). Nunca bloquea el trabajo.
- El contrato "lo ves en el seam" (observaciones de estancamiento tras 3 seams, ancla de reentrada
  tras 30 min de gap) reproduce el original.

## El skill

`skills/j-space/SKILL.md` — la entrada con premisa, routing de passes (fast/full/loop), seams,
registros (inner/ledger/outer) e invariantes. Los 9 módulos y 3 referencias mantienen su
contenido y sus rutas relativas al directorio del skill, igual que el original.

- `/skill:j-space` lo carga bajo demanda.
- `/jspace-verify` corre las comprobaciones de integridad de autoría (una entrada, una premisa
  byte-idéntica en los 9 módulos, sin hablar de versiones).

## Verificación

```bash
python3 scripts/verify_suite.py        # integridad del skill
python3 -m unittest discover -s tests  # tests de regresión del controlador
```

## Layout

```
extension.ts            # registra tool jspace, skill, /jspace-verify
skills/j-space/         # SKILL.md + modules/ (9) + references/ (3)
scripts/                # jspace.py, verify_suite.py, workspace-ledger.md (vendored 1:1)
tests/                  # test_jspace.py (vendored, rutas adaptadas)
.github/workflows/      # CI: verify_suite + tests (matriz 3 SO)
```

`scripts/*.py`, `tests/*.py` y `.github/` están excluidos del escaneo de pi-lens
(`.pi-lens.json`): son código upstream vendido y congelado, no debe tocarse por lint.
