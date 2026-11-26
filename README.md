# opencode-voz

Plugin de OpenCode para macOS con ida y vuelta completa por voz: lee en voz alta
las respuestas del asistente y permite dictar mensajes por micrófono directo al
chat desde la app de escritorio.

## Qué hace

Podés ver el detalle completo de todas las funcionalidades en [`FEATURES.md`](./FEATURES.md).

## Novedades (dictado, barra de controles y servidores remotos)

- **Sin popup de grabación:** mientras dictás, la barra arriba del cuadro de
  escritura muestra una barra horizontal de nivel con los segundos, **Pausar /
  Reanudar**, **Cancelar** y **Enviar voz**. Se ocultan las pills normales,
  incluida **Ajustes**, y vuelven al terminar.
- **Ajustes en un solo menú:** la pill **"Ajustes"** abre un menú con Auto-mic,
  Voz (femenina/masculina), Motor (Auto/ElevenLabs/Groq), Eco, Espera para
  enviar (2/3/5/10/20 segundos, tocás para ciclar), Audio entre hilos
  (cortar anterior / esperar turno, lo mismo que `/cortar`) y Corregir
  vocabulario (abre la lista de palabras, lo mismo que `/corregir`). Reemplaza
  a las cuatro pills que estaban en la barra; en remoto estos controles apuntan
  al plugin local.
- **El texto va al compositor:** al transcribir, se pega en el cuadro de
  escritura y aparece **"Enviar en Ns"**; si lo tocás o editás el texto, se
  cancela la cuenta y mandás con Enter cuando quieras. Un clic sin editar no
  cancela el envío. Si había texto escrito antes, se preserva.
- **Servidores remotos:** el dictado se transcribe en la Mac con las claves
  locales, así que no hace falta instalar el plugin ni las claves en el
  servidor. Las respuestas del servidor se leen también en la Mac, con el mismo
  motor de voz; **Voz / Pausar voz / Detener / Silenciar** funcionan igual que
  en una sesión local, y **Voz** repite el último mensaje remoto.
- **Sin solapes:** si se está leyendo otra sesión, el texto remoto corta esa
  lectura antes de empezar; los bloques de una misma sesión se encolan. Al
  apretar **Dictar** se corta la lectura en curso también en remoto.
- **Logs:** `~/.local/share/opencode/log/voz-dictado.log` para transcripciones y
  `~/.local/share/opencode/log/voz-remoto.log` para el diagnóstico de lectura
  remota, la repetición y cada inicio/corte de la cuenta regresiva.

### Lectura en voz alta (TTS)
- **Streaming oración por oración:** empieza a generar el audio mientras el
  asistente todavía está escribiendo (salteando bloques de código) y pre-genera
  la oración siguiente en paralelo.
- **Arranque rápido:** mantiene un trabajador de `edge-tts` y el reproductor
  nativo de macOS (`AVAudioPlayer`) listos en memoria apenas mandás un mensaje.
- **Apagado por sesión ("Voz ON / Voz OFF"):** pill a la izquierda de la barra
  que apaga lectura, avisos, Auto-mic y dictado solo en esa sesión (esconde el
  resto de las pills, corta de inmediato su audio y cola incluso entre
  instancias, y no interfiere con otras sesiones prendidas).
- **Pausa real y repetición por sesión:** pill **"Voz"** arriba del cuadro de escritura:
  - **Voz** (gris): en reposo; al hacer clic repite el último mensaje leído de
    esa sesión al instante (separado por charla).
  - **Pausar voz** (verde): reproduciendo; al hacer clic pausa en el milisegundo
    exacto.
  - **Seguir voz** (rojo): en pausa; al hacer clic retoma desde donde quedó.
  - **Voz apagada** (gris): silenciado; al hacer clic vuelve a activar la voz.
- **Eco y avisos de actividad (con pill "Eco"):** lee tu mensaje (`"Tú: …"` en
  la voz contraria a la del asistente, omitiendo código, capturas completas de
  terminal Linux/SSH, tablas en columnas y HTML pegado), avisa "Trabajando",
  herramientas en uso ("Usando Leer", "Usando Terminal", etc.) y permisos
  pendientes. Desde **Ajustes > Eco** podés apagar el eco, "Trabajando." y
  herramientas dejando solo las respuestas y `"Permiso pendiente."`.
- **Voz femenina / masculina:** desde **Ajustes > Voz** alternás al instante
  entre Dalia (`es-MX-DaliaNeural`) y Carlos (`es-HN-CarlosNeural`), guardado
  y sincronizado entre instancias.
- **Corte automático y coordinación entre sesiones (`/cortar`):** por defecto
  en modo **cortar**, apenas otra sesión empieza a responder frena al instante
  el audio anterior (incluso entre proyectos distintos) para que nunca se
  mezclen dos voces. Con `/cortar` alternás a modo **esperar turno** (y
  viceversa), guardado y sincronizado entre instancias.
- **Motor dual:** `edge` (voces neuronales de Microsoft, requiere internet) o
  `say` (voz local de macOS, offline). En `auto` usa `edge` si está instalado.

### Dictado por voz (STT), VAD y Auto-mic
- **Botón "Dictar"** con borde rojo bien visible (relleno rojo al presionarlo o
  mientras graba) al lado de "Voz" arriba del cuadro de escritura:
  - Corta y bloquea la voz del asistente, pide el micrófono en silencio y suena
    el beep antes de empezar a grabar. No se abre ningún modal: la charla de
    atrás queda totalmente visible y se puede scrollear mientras dictás.
  - Mientras grabás, la barra muestra **nivel de micrófono en 8 segmentos**
    (`████░░░░`) junto a los segundos, más **Pausar / Reanudar**, **Cancelar** y
    **Enviar voz**. `Enter` corta y transcribe al instante.
  - Al transcribir, el texto se pega en el compositor con una cuenta regresiva
    cancelable: tocá el pill **"Enviar en Ns"** para editar tranquilo y mandá
    con Enter, o esperá a que se envíe solo.
  - Transcribe con **ElevenLabs Scribe v3** o **Groq Whisper**, elegible desde
    **Ajustes > Motor** (automático con respaldo, o uno solo),
    usando vocabulario personalizado desde `~/.config/opencode/voz-vocabulario.md`,
    editable rápido con `/corregir palabra` o `/corregir lista`.
  - Cada intento queda en `~/.local/share/opencode/log/voz-dictado.log`
    (incluyendo si se envió vocabulario y cuántos términos/caracteres), y si
    falta la clave del motor elegido el popup avisa cuál falta.
- **Modo Auto-mic on / off** (**Ajustes > Auto-mic**): mientras
  esté prendido vuelve a abrir el micrófono automáticamente al terminar cada
  respuesta (enviando siempre al hilo que respondió, aunque estés mirando otro,
  y salteando la tanda si estás escribiendo con teclado), cierra solo si pasan
  8 segundos sin voz y se apaga con beep largo al decir **"dejar de escuchar"**
  o **"deja de escuchar"**. En remoto se dispara con el evento local
  `lecturaTerminada` (el plugin no ve los eventos del servidor ajeno, así que
  no emitía `turnoTerminado`).
- **Efectos de sonido:** `assets/beep.wav` al abrir el popup de dictado,
  `assets/beep-error.wav` (largo y agudo) si pasan 8 segundos sin voz, al
  apagar Auto-mic por voz o si falla la transcripción, `assets/staplebops-01.aac`
  al cortar la grabación y `assets/staplebops-02.aac` al enviar el dictado y al
  finalizar la lectura.

### Comandos
- `/cortar` — Alterna entre cortar el audio de otra sesión (por defecto) o esperar turno.
- `/corregir palabra` — Agrega una palabra o frase al vocabulario de dictado.
- `/corregir` o `/corregir lista` — Muestra las palabras guardadas y permite sumar nuevas.
- Paleta de comandos: **Vocabulario de voz (`/corregir`)**, **Cortar audio de
  otro hilo (`/cortar`)**, **Cambiar voz femenina o masculina**, **Activar o
  desactivar Auto-mic**, **Dictar mensaje por voz**, **Pausar o seguir la voz**,
  **Repetir el último mensaje**, **Detener la voz**, **Silenciar o activar la voz**.

## Estructura

```text
src/index.ts   motor de voz, trabajadores persistentes, eventos, avisos y transcripción (servidor)
src/rpc.ts     contrato RPC entre la parte gráfica y el servidor
src/gui.tsx    pills ("Voz", "Dictar", "Auto-mic on/off", "Fem/Masc"), VAD, compositor y comandos (app de escritorio)
assets/        efectos de sonido (beep.wav, staplebops-01.aac, staplebops-02.aac)
FEATURES.md    descripción completa de todas las funcionalidades del sistema
```

## Compilar

```bash
npm install
npm run build
```

Genera `dist/gui-experimental.cjs`, que es lo que carga la app de escritorio.

## Instalar

1. Clonar el repositorio y compilar la parte gráfica:

   ```bash
   git clone https://github.com/deztino/opencode-voz.git ~/opencode-voz
   cd ~/opencode-voz
   npm install
   npm run build
   ```

2. Agregar el plugin en `~/.config/opencode/opencode.json`:

   ```json
   "plugins": ["/Users/tu-usuario/opencode-voz"]
   ```

3. (Opcional, para mejores voces en streaming) Instalar `edge-tts`:

   ```bash
   pipx install edge-tts
   ```

   Si no está instalado, usa automáticamente la voz local `say` de macOS.

4. Para usar el dictado por voz, agregar las claves en
   `~/.config/opencode/.env` (con una alcanza; con las dos tenés respaldo):

   ```bash
   ELEVENLABS_API_KEY=tu_clave
   GROQ_API_KEY=tu_clave
   ```

5. Reiniciar la app de escritorio (Cmd+Q y volver a abrir).

## Variables de entorno

| Variable | Para qué |
| --- | --- |
| `OPENCODE_TTS_ENGINE` | `edge`, `say` o `auto` (por defecto) |
| `OPENCODE_TTS_CONCURRENCIA` | `cortar` (por defecto) o `esperar` cuando hablan dos sesiones a la vez |
| `OPENCODE_TTS_VOICE` | voz femenina de `edge-tts` (por defecto `es-MX-DaliaNeural`) |
| `OPENCODE_TTS_MALE_VOICE` | voz masculina de `edge-tts` (por defecto `es-HN-CarlosNeural`) |
| `OPENCODE_TTS_RATE` | velocidad de `edge-tts` (por ejemplo `+10%`) |
| `OPENCODE_TTS_SAY_VOICE` | voz femenina de respaldo de macOS (por defecto `Mónica`) |
| `OPENCODE_TTS_SAY_MALE_VOICE` | voz masculina de respaldo de macOS (por defecto `Jorge`) |
| `OPENCODE_TTS_RATE_SAY` | palabras por minuto de `say` |
| `ELEVENLABS_API_KEY` | clave para transcripción con ElevenLabs Scribe |
| `GROQ_API_KEY` | clave alternativa para transcripción con Groq Whisper |
| `OPENCODE_STT_ELEVENLABS_MODEL` | modelo de ElevenLabs (por defecto `scribe_v3`) |
| `OPENCODE_STT_LANG` | idioma ISO-639-3 para ElevenLabs (por defecto `spa`) |
| `OPENCODE_STT_GROQ_MODEL` | modelo de Groq (por defecto `whisper-large-v3-turbo`) |
| `OPENCODE_STT_GROQ_LANG` | idioma para Groq (por defecto `es`) |
| `OPENCODE_STT_VOCAB_FILE` | ruta al archivo de vocabulario (por defecto `~/.config/opencode/voz-vocabulario.md`) |
