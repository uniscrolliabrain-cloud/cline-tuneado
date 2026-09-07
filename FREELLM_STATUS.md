# Estado del tuneo: FreeLLMAPI (local) + fallback OpenRouter

> Fecha: 07/09/2026 · Rama: `main`
> Objetivo: Cline arranca por defecto con un provider `openai-compatible` apuntando
> a FreeLLMAPI en localhost, y si el localhost no responde, conmuta solo a OpenRouter.

---

## ✅ Qué está hecho y VERIFICADO

### 1. Provider por defecto — `sdk/packages/shared/src/providers/defaults.ts`
- `DEFAULT_API_PROVIDER = "freellmapi"` (provider openai-compatible local).
- Constantes configurables arriba del archivo, fáciles de cambiar:
  - `FREELLM_BASE_URL` → `http://127.0.0.1:31415`
  - `FREELLM_API_KEY` → key de FreeLLMAPI (hardcodeada a petición expresa)
  - `FREELLM_DEFAULT_MODEL_ID = "auto"` (el router local elige modelo)
  - `OPENROUTER_BASE_URL` → `https://openrouter.ai/api/v1`
  - `OPENROUTER_API_KEY_ENV` → `"OPENROUTER_API_KEY"`
  - `OPENROUTER_FALLBACK_MODEL_ID` → modelo que usa el fallback
- Exportado también desde `shared/src/index.ts` (Node) e `index.browser.ts`.

### 2. Builtin registrado — `sdk/packages/llms/src/providers/builtins.ts`
- Spec `freellmapi` (familia `openai-compatible`) con baseUrl local, modelo
  por defecto `auto` y `modelsSourceUrl = {baseUrl}/v1/models`.

### 3. Lógica de fallback — `sdk/packages/llms/src/providers/vendors/openai-compatible.ts`
- `createFreeLlmFallbackFetch()`: envuelve el fetch del provider. Si el
  localhost no responde con **error de red/transporte** (ECONNREFUSED, fetch
  failed, timeout…), reenvía la misma petición a OpenRouter.
- `rewriteUrlToOpenRouter()`: reescribe la URL quitando el prefijo `/v1/` del
  local y uniéndola a la base de OpenRouter (`/v1/chat/completions` →
  `/api/v1/chat/completions`). Preserva query strings.
- El fallback reescribe la cabecera `Authorization` con la key de
  `process.env.OPENROUTER_API_KEY` y el campo `model` de payloads JSON al
  `OPENROUTER_FALLBACK_MODEL_ID`. Funciona igual para streaming, `/responses`
  y `/models` (es agnóstico al endpoint).
- **Importante:** un error HTTP del servidor local (401/429/502/503) **no**
  dispara el fallback — el error se muestra tal cual. Solo falla de red.
- Si no hay `OPENROUTER_API_KEY` en el entorno, no hay fallback (usa el fetch
  original).

### 4. Apps
- **VSCode:** `apps/vscode/src/shared/api.ts`, `apps/vscode/src/core/storage/utils/state-helpers.ts`,
  `apps/vscode/src/sdk/model-catalog/provider-id.ts` → el default apunta a `freellmapi`.
- **CLI:** `apps/cli/src/runtime/defaults.ts`, `apps/cli/src/main.ts`,
  `apps/cli/src/connectors/session-runtime.ts` → ídem.
- **Core:** `sdk/packages/core/src/services/llms/provider-defaults.ts` + export en `core/src/index.ts`.

---

## 🧪 Verificación ejecutada

| Check | Resultado |
|---|---|
| `bun -F @cline/shared typecheck` | ✅ exit 0 |
| `bun -F @cline/llms typecheck` | ✅ exit 0 |
| `bun -F @cline/core typecheck` (smoke) | ✅ exit 0 |
| `bun -F @cline/cli typecheck` | ✅ exit 0 (run previo a los 2 últimos fixes, que solo tocaron llms) |
| `bun -F @cline/vscode typecheck` | ✅ exit 0 (run previo, ídem) |
| `bun test` (openai-compatible-freellm.test.ts) | ✅ 9/9 |
| `bunx vitest run` (builtins.test.ts + freellm.test.ts) | ✅ 31/31 |
| Probe real contra `http://127.0.0.1:31415` | ✅ `/v1/models` responde y chat completion con modelo `auto` funciona |

Tests nuevos en `sdk/packages/llms/src/providers/vendors/openai-compatible-freellm.test.ts`:
registro del builtin, reescritura de URLs, preservación de query strings,
passthrough cuando el local responde, fallback ante error de red, y NO-fallback
ante error HTTP.

---

## ⚠️ Lo que falta / para tu auditoría

1. **Fallback end-to-end en vivo no probado**: está verificado con mocks
   unitarios y el servidor local real responde, pero no se ha parado el
   localhost con Cline abierto para ver la conmutación real a OpenRouter.
2. **`OPENROUTER_API_KEY` debe estar en el entorno** (no está en el código).
   Para la CLI: `set OPENROUTER_API_KEY=sk-or-…` antes de arrancar. Para la
   extensión VSCode, hereda el entorno de la terminal/VS Code.
3. **Seguridad — keys en el repo**: `FREELLM_API_KEY` está hardcodeada en
   `defaults.ts` (así se pidió). Si este repo de GitHub es público, la key
   queda expuesta → rótala cuando puedas y ponla tras un reverse proxy.
4. **Re-run de typecheck cli/vscode** tras los últimos 2 fixes: los fixes solo
   tocaron `openai-compatible.ts` (llms, ya ✅) y su test, pero conviene un
   `bun -F @cline/cli typecheck && bun -F @cline/vscode typecheck` final.
5. **`bun.lock` modificado**: revisar el diff antes de mergear.
6. **Modelo de fallback**: el `model` solo se reescribe en payloads JSON; el
   fallback usa `OPENROUTER_FALLBACK_MODEL_ID` de `defaults.ts` — ajústalo al
   modelo de OpenRouter que prefieras (ej. `anthropic/claude-sonnet-4.5`).
7. **`cline_prompt.md`** queda sin trackear a propósito (tu nota de trabajo).

---

## 🔧 Dónde tocar la configuración

Todo en un solo sitio: `sdk/packages/shared/src/providers/defaults.ts`
(URL y key de FreeLLMAPI, URL y modelo de fallback de OpenRouter, y el
nombre del provider por defecto).
