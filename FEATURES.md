# Funcionalidades de opencode-voz

Plugin de OpenCode para macOS que brinda una conversación completa ida y vuelta por voz: lee en voz alta las respuestas y avisos del asistente, y permite dictar mensajes con detección automática de voz y manos libres.

## 1. Lectura en voz alta (TTS)

- **Motor dual con selección automática:**
  - `edge`: usa `edge-tts` (voces neuronales de Microsoft; femenina `es-MX-DaliaNeural` y masculina `es-HN-CarlosNeural`).
  - `say`: usa la voz local de macOS sin internet, eligiendo automáticamente la mejor variante instalada (`Premium` > `Enhanced` > normal; femenina `Mónica` y masculina `Jorge`).
  - `auto` (por defecto): usa `edge` si está instalado y `say` como respaldo.
- **Selector de voz femenina / masculina:** pill **"Fem / Masc"** a la derecha de Auto-mic (gris en Fem, ámbar en Masc, más comando en la paleta) que alterna entre Dalia y Carlos, guarda la preferencia y la sincroniza entre instancias al instante.
- **Streaming oración por oración:** comienza a sintetizar y leer apenas llegan las primeras oraciones del asistente, salteando bloques de código y numeraciones sueltas, con un límite de 6.000 caracteres por respuesta. Pre-genera la oración siguiente en paralelo mientras suena la actual.
- **Trabajadores persistentes y precalentamiento:** mantiene en memoria un proceso Python para `edge_tts` y un reproductor nativo de macOS en JXA (`AVAudioPlayer`), precalentados apenas enviás un mensaje para reducir la latencia.
- **Pausa y reanudación exactas:** pausa en el milisegundo exacto (mediante archivo de control en `AVAudioPlayer` o `SIGSTOP`/`SIGCONT` en `say`) y retoma desde donde quedó.
- **Repetición instantánea por sesión:** guarda temporalmente los audios de la última respuesta de cada sesión por separado (hasta 20 charlas) para volver a leerla sin sintetizar de nuevo y sin mezclar mensajes entre sesiones.
- **Corte automático y coordinación global entre sesiones (`/cortar`):** coordina el turno de audio entre todas las instancias del plugin para que nunca se mezclen dos voces. Por defecto funciona en modo **cortar** (apenas otra sesión empieza a hablar corta al instante el reproductor anterior y descarta su cola sin caer al respaldo `say`); con `/cortar` alternás a modo **esperar turno** (y viceversa), sincronizado entre instancias.
- **Pill "Voz ON / Voz OFF" por sesión:** aparece primera a la izquierda (verde en ON, ámbar en OFF). Al apagar una sesión, esconde las demás pills, corta de inmediato el reproductor y la cola pendiente de esa sesión (incluso entre instancias), ignora sus eventos y bloquea Auto-mic y dictado en esa charla, sin interferir con otras sesiones prendidas. Se guarda por sesión.
- **Pill "Voz" arriba del cuadro de escritura:**
  - **Voz** (gris): en reposo; repite el último mensaje leído.
  - **Pausar voz** (verde): reproduciendo; pausa la lectura.
  - **Seguir voz** (rojo): en pausa; retoma la lectura.
  - **Voz apagada** (gris): lectura silenciada; vuelve a activarla.

## 2. Eco del usuario y avisos de actividad

- **Eco de tus mensajes con voz alternada:** al enviar un mensaje lee `"Tú: "` seguido del texto usando siempre la voz contraria a la del asistente (si el asistente habla con Carlos, tu eco sale con Dalia; y al revés), omitiendo bloques de código, HTML pegado, capturas completas de terminal Linux/SSH y macOS (`usuario@host:ruta$`, `usuario ~ %`), salidas en columnas (`systemctl`, `free -m`, `ps`, `df`, etc.) y líneas técnicas.
- **Pill "Eco" global (prender / apagar):** botón a la derecha del motor (verde prendido, gris apagado, sincronizado entre instancias). Al apagarlo silencia `"Tú: …"`, `"Trabajando."` y los avisos de herramientas (`"Usando …"`), dejando solo las respuestas del asistente y `"Permiso pendiente."`.
- **Avisos cacheados** (no pisan la última respuesta guardada):
  - **"Trabajando."**: suena 3 segundos después de terminar `"Tú: …"` y se repite cada 30 segundos mientras la ejecución siga activa sin lectura en curso.
  - **Herramientas en uso**: agrupa y anuncia las herramientas llamadas (`Usando Leer.`, `Usando Terminal.`, `Usando 2 Leer y Buscar en archivos.`, etc.), espaciadas al menos 3 segundos tras el audio anterior.
  - **Permisos**: avisa `"Permiso pendiente."` cuando OpenCode pide autorización y confirma tu decisión (`"Permitido una vez."`, `"Permitido siempre."` o `"Permiso rechazado."`).
- **Coordinación entre múltiples instancias:**
  - Lock por evento (`opencode-tts-seen-*.lock`) para no duplicar lecturas ni ecos.
  - Estado compartido del eco (`opencode-tts-eco-estado.json`) para esperar a que termine `"Tú: …"` antes de los avisos.
  - Estado compartido de lectura (`opencode-tts-hablando-estado.json`) para que ninguna instancia reproduzca `"Trabajando."` ni avisos de herramientas mientras otra está leyendo una respuesta.
  - Estado compartido de dictado (`opencode-tts-dictando-estado.json`) para bloquear toda lectura y avisos mientras el popup de dictado está abierto.
  - Bloqueo compartido con enfriamiento de 8 segundos (`opencode-tts-trabajando.lock` y `opencode-tts-trabajando-estado.json`, reiniciado con cada mensaje nuevo) para que `"Trabajando."` nunca se reproduzca solapado entre instancias.

## 3. Dictado por voz (STT) y detección automática (VAD)

- **Acceso rápido:** pill **"Dictar"** con borde rojo bien visible (fondo transparente en reposo, relleno rojo al presionarlo o mientras graba) al lado de "Voz".
- **Popup unificado instantáneo y translúcido:** corta y bloquea la voz del asistente, solicita el micrófono en silencio y apenas está listo abre el popup junto con el beep para empezar a grabar sin demora. Su fondo queda suavemente translúcido (72 por ciento) sin oscurecer el chat de atrás, manteniendo letras y botones al 100 por ciento de nitidez:
  - **Grabando**: punto rojo pulsante, contador (`MM:SSs`), **semáforo de audio utilizable** (rojo al arrancar, verde con brillo al juntar 400 ms reales de voz por encima del umbral), **selector numérico ▲▼** (de 1 a 20 segundos, guardado en `localStorage`, por defecto 5) que regula a la vez la espera de silencio del VAD y la cuenta regresiva de envío, medidor visual del nivel de micrófono y botón **Pausar / Reanudar**.
  - **Transcribiendo**: indicador de carga mientras procesa el audio.
  - **Confirmar dictado**: cuadro editable con cuenta regresiva automática (usa los mismos segundos elegidos en el selector) antes del envío. `Enter` envía ya, `Shift+Enter` agrega salto de línea, `Escape` cancela, y escribir, mover el cursor o hacer clic pausa la cuenta regresiva.
  - **Error**: muestra el detalle completo con botón **Copiar error**.
- **Detección de actividad de voz (VAD):**
  - Captura audio con cancelación de eco y supresión de ruido (`echoCancellation`, `noiseSuppression`).
  - Espera a que termine el beep antes de arrancar la grabación y el VAD, salta 250 milisegundos iniciales antes de detectar voz y espera 600 milisegundos (con tope en `0.008`) antes de calibrar el piso de ruido para que el eco del beep no suba la vara.
  - **Modo manual:** requiere 200 ms de voz por encima de 2,1 veces el piso de ruido (umbral mínimo `0.006`).
  - **Modo Auto-mic:** requiere 200 ms de voz por encima de 2,1 veces el piso de ruido (umbral mínimo `0.009`).
  - **Cierre sin voz con aviso sonoro:** tanto en dictado manual como en Auto-mic, si pasan 8 segundos sin detectar voz, cierra solo sin gastar cuota y reproduce un beep largo y agudo (`assets/beep-error.wav`) para avisarte aunque estés lejos de la pantalla. También suena si la grabación fue muy corta, volvió vacía o hubo error al transcribir.
  - **Corte automático por silencio:** detiene y transcribe tras el silencio configurado en el selector ▲▼ (5 segundos por defecto, con paciencia proporcional de +1 segundo en dictados de más de 9 segundos y +2 segundos en dictados de más de 20 segundos). `Enter` corta y transcribe al instante; `Escape` cancela sin gastar cuota.
- **Foco automático:** al cerrar el popup o tocar los pills devuelve el foco al cuadro de escritura (`composer.focus()`).
- **Motores de transcripción con selector en la barra:**
  - Principal: **ElevenLabs Scribe** (`scribe_v3` por defecto, con `tag_audio_events=false` para ignorar ruidos ambientales).
  - Respaldo: **Groq Whisper** (`whisper-large-v3-turbo`).
  - Pill **"Auto / Eleven / Groq"** a la derecha de Fem/Masc: rota entre automático (ElevenLabs y, si falla, Groq), solo ElevenLabs y solo Groq. Se guarda y se sincroniza entre ventanas.
  - Si falta la clave del motor elegido, el popup muestra un error con el nombre de la clave faltante (`ELEVENLABS_API_KEY` o `GROQ_API_KEY`) en lugar de fallar en silencio.
  - Cada intento queda anotado en `~/.local/share/opencode/log/voz-dictado.log` (hora, motor, proveedor, si se envió vocabulario con cantidad de términos y caracteres/keyterms, duración, caracteres y error recortado), que se recorta solo a las últimas 200 líneas.
- **Vocabulario personalizado y comando `/corregir`:** lee `~/.config/opencode/voz-vocabulario.md` (una palabra o frase por línea, ignorando líneas vacías y comentarios `#`), con recarga automática al modificarse. Envía hasta 100 `keyterms` a ElevenLabs y un `prompt` de hasta 600 caracteres a Groq.
  - `/corregir palabra o frase`: guarda el término directamente sin duplicados.
  - `/corregir` o `/corregir lista`: abre un diálogo con el campo para agregar nuevas palabras y la lista completa de términos cargados.
- **Lectura de claves API:** busca `ELEVENLABS_API_KEY` y `GROQ_API_KEY` en variables de entorno o en `~/.hermes/.env`, `~/.config/opencode/.env` y `~/.env`.

## 4. Modo Auto-mic y comando de voz

- **Pill "Auto-mic on / Auto-mic off"** al lado de "Dictar" (gris apagado, verde prendido; el estado se guarda en `localStorage`).
- **Conversación continua manos libres y envío al hilo de origen:** mientras esté en **Auto-mic on**, espera 400 ms tras finalizar la lectura en voz alta de cualquier respuesta (incluso si escribiste por teclado) y vuelve a abrir el micrófono solo hasta que lo apagues, guardando el `sessionID` del hilo que habló para enviar tu respuesta siempre a ese hilo aunque estés mirando otro.
- **No interrumpe si estás escribiendo:** si detecta que tocaste teclas en los últimos 4 segundos o que ya hay texto escrito en el cuadro del chat, saltea esa tanda sin abrir el popup y mantiene Auto-mic prendido para la siguiente.
- **Cierre sin voz:** si pasan 8 segundos sin detectar voz en modo Auto-mic, cierra el popup automáticamente sin transcribir ni consumir cuota.
- **Comandos de voz `"dejar de escuchar"` / `"deja de escuchar"`:** si la transcripción dice exactamente `"dejar de escuchar"` o `"deja de escuchar"` (sin importar mayúsculas, tildes ni signos de puntuación), reproduce el beep largo (`assets/beep-error.wav`), apaga Auto-mic automáticamente, cierra el dictado sin enviarlo al chat y muestra un aviso en pantalla.

## 5. Efectos de sonido

Reproducidos de forma nativa en macOS mediante `afplay`:

- `assets/beep.wav` (910 Hz, 320 ms): suena al mostrarse el popup de dictado, esperando a que termine antes de arrancar la grabación y el VAD.
- `assets/beep-error.wav` (1450 Hz, 650 ms): beep fuerte, largo y agudo cuando el dictado se cierra por falta de voz (8 segundos), al apagar Auto-mic por voz (`"dejar de escuchar"` / `"deja de escuchar"`), grabación muy corta, texto vacío o error al transcribir.
- `assets/staplebops-01.aac`: suena al detener la grabación del dictado.
- `assets/staplebops-02.aac`: suena al enviar el texto dictado y al terminar de leer en voz alta cada respuesta del asistente.

## 6. Comandos

- `/cortar`: Alterna entre cortar el audio de otra sesión (por defecto) o esperar turno.
- `/corregir palabra`: Agrega una palabra o frase al vocabulario de dictado.
- `/corregir` o `/corregir lista`: Muestra la lista actual del vocabulario y permite agregar nuevos términos.
- **Paleta de comandos:**
  - Vocabulario de voz (`/corregir`)
  - Cortar audio de otro hilo (`/cortar`)
  - Cambiar voz femenina o masculina
  - Activar o desactivar Auto-mic
  - Dictar mensaje por voz
  - Pausar o seguir la voz
  - Repetir el último mensaje
  - Detener la voz
  - Silenciar o activar la voz

## 7. Arquitectura

```text
src/index.ts               Motor TTS/STT, trabajadores persistentes, eventos, avisos y sonidos (servidor)
src/rpc.ts                 Contrato RPC de métodos y eventos entre la interfaz y el servidor
src/gui.tsx                Pills ("Voz", "Dictar", "Auto-mic on/off", "Fem/Masc"), popups, VAD y comandos (GUI)
assets/                    Efectos de sonido (beep.wav, staplebops-01.aac, staplebops-02.aac)
dist/gui-experimental.cjs  Paquete compilado de la interfaz gráfica (generado con npm run build)
```

## 8. Variables de entorno

| Variable | Descripción | Valor por defecto |
| --- | --- | --- |
| `OPENCODE_TTS_ENGINE` | Motor de lectura (`edge`, `say` o `auto`) | `auto` |
| `OPENCODE_TTS_CONCURRENCIA` | Comportamiento cuando hablan dos sesiones (`cortar` o `esperar`) | `cortar` |
| `OPENCODE_TTS_BIN` | Ruta personalizada al binario `edge-tts` | detección automática |
| `OPENCODE_TTS_VOICE` | Voz femenina de `edge-tts` | `es-MX-DaliaNeural` |
| `OPENCODE_TTS_MALE_VOICE` | Voz masculina de `edge-tts` | `es-HN-CarlosNeural` |
| `OPENCODE_TTS_RATE` | Velocidad de `edge-tts` (ej. `+10%`) | `+0%` |
| `OPENCODE_TTS_SAY_VOICE` | Voz femenina de respaldo de macOS `say` | `Mónica` |
| `OPENCODE_TTS_SAY_MALE_VOICE` | Voz masculina de respaldo de macOS `say` | `Jorge` |
| `OPENCODE_TTS_RATE_SAY` | Palabras por minuto de `say` | predeterminada del sistema |
| `ELEVENLABS_API_KEY` | Clave API para ElevenLabs Speech-to-Text | — |
| `GROQ_API_KEY` | Clave API de respaldo para Groq Whisper | — |
| `OPENCODE_STT_ELEVENLABS_MODEL` | Modelo de ElevenLabs STT | `scribe_v3` |
| `OPENCODE_STT_LANG` | Idioma ISO-639-3 para ElevenLabs | `spa` |
| `OPENCODE_STT_GROQ_MODEL` | Modelo de Groq Whisper | `whisper-large-v3-turbo` |
| `OPENCODE_STT_GROQ_LANG` | Idioma para Groq Whisper | `es` |
| `OPENCODE_STT_VOCAB_FILE` | Ruta al archivo de vocabulario personalizado | `~/.config/opencode/voz-vocabulario.md` |
