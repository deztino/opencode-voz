# Funcionalidades de opencode-voz

Plugin de OpenCode para macOS que brinda una conversación completa ida y vuelta por voz: lee en voz alta las respuestas y avisos del asistente, y permite dictar mensajes con detección automática de voz y manos libres.

## 1. Lectura en voz alta (TTS)

- **Motor dual con selección automática:**
  - `edge`: usa `edge-tts` (voces neuronales de Microsoft; femenina `es-MX-DaliaNeural` y masculina `es-HN-CarlosNeural`).
  - `say`: usa la voz local de macOS sin internet, eligiendo automáticamente la mejor variante instalada (`Premium` > `Enhanced` > normal; femenina `Mónica` y masculina `Jorge`).
  - `auto` (por defecto): usa `edge` si está instalado y `say` como respaldo.
- **Selector de voz femenina / masculina:** desde **Ajustes > Voz** (más comando en la paleta) alternás entre Dalia y Carlos, guardás la preferencia y la sincronizás entre instancias al instante.
- **Streaming oración por oración:** comienza a sintetizar y leer apenas llegan las primeras oraciones del asistente, salteando bloques de código y numeraciones sueltas, con un límite de 6.000 caracteres por respuesta. Pre-genera la oración siguiente en paralelo mientras suena la actual.
- **Trabajadores persistentes y precalentamiento:** mantiene en memoria un proceso Python para `edge_tts` y un reproductor nativo de macOS en JXA (`AVAudioPlayer`), precalentados apenas enviás un mensaje para reducir la latencia.
- **Pausa y reanudación exactas:** pausa en el milisegundo exacto (mediante archivo de control en `AVAudioPlayer` o `SIGSTOP`/`SIGCONT` en `say`) y retoma desde donde quedó.
- **Repetición instantánea por sesión:** guarda temporalmente los audios de la última respuesta de cada sesión por separado (hasta 20 charlas) para volver a leerla sin sintetizar de nuevo y sin mezclar mensajes entre sesiones.
- **Corte automático y coordinación global entre sesiones (`/cortar`):** coordina el turno de audio entre todas las instancias del plugin para que nunca se mezclen dos voces. Por defecto funciona en modo **cortar** (apenas otra sesión empieza a hablar corta al instante el reproductor anterior y descarta su cola sin caer al respaldo `say`); con `/cortar` alternás a modo **esperar turno** (y viceversa), sincronizado entre instancias.
- **Voz ON / Voz OFF por sesión:** el interruptor se mudó adentro de **Ajustes > Voz** (cuando está encendida no aparece como pill). Al apagar una sesión queda una sola pill **"PLUGIN VOZ"** (ámbar, todo en mayúscula para que se entienda que apaga el plugin entero) para volver a prenderla; esconde las demás pills, corta de inmediato el reproductor y la cola pendiente de esa sesión (incluso entre instancias), ignora sus eventos y bloquea Auto-mic y dictado en esa charla, sin interferir con otras sesiones prendidas. Se guarda por sesión.
- **Pills de audio arriba del cuadro de escritura:**
  - **Escuchar** (borde e ícono verdes): en reposo; reproduce el audio seleccionado. Fondo transparente y borde verde (`#22c55e`), con el ícono interior del mismo verde y hover al 30 por ciento (`rgba(34, 197, 94, 0.3)`), a juego con el borde naranja de **Dictar**. Si no hay audio ni texto guardado de una respuesta en esa sesión, se muestra con icono de prohibido y sin acción, con el **texto en gris** (CSS propio que pinta de gris los pills sin acción); se habilita apenas termina de leerse la primera respuesta.
  - **Pausar voz** (verde): reproduciendo; pausa la lectura. El icono alterna entre dos dibujos de onda cada 1 segundo mientras se reproduce, para que se vea que está hablando.
  - **En cola** (ámbar): el audio todavía no suena (esperando el turno, la síntesis o la cola) y se muestra antes de **Pausar voz**, con **Stop** disponible para cancelarlo. El estado sale del flag `enCola` del servidor, que se enciende al encolar y se apaga cuando empieza a sonar de verdad. En sesiones remotas se ve **En cola** un rato antes de que suene: es intencional, porque primero se lee el contexto del servidor y se sintetiza el MP3 acá; en local casi siempre hay audio cacheado y arranca enseguida.
  - **Seguir voz** (rojo): en pausa; retoma la lectura.
  - **Stop** (rojo): aparece mientras se reproduce o está en cola; corta la lectura al instante (no hace que escuchar hasta el final para volver atrás).
  - **◀ / ▶**: navegan entre los audios guardados, cortan lo que esté sonando, reproducen el nuevo y cancelan el Auto-mic. Se muestran **solo cuando tienen destino** (la que no tiene adónde ir se oculta, igual que Stop cuando no se reproduce); la que se muestra se pinta de **amarillo** (`Reproducir la respuesta anterior/siguiente`) y lleva fondo gris semitransparente. Por defecto queda seleccionado el audio **más reciente**: si nunca hiciste hacia atrás aparece sola la ◀, y si retrocedés aparece sola la ▶, que va antes que **Stop** para que el primer botón sea el de navegación.
  - **Voz apagada** (gris): lectura silenciada; vuelve a activarla.
- **Fondo al 80 por ciento:** todos los botones del plugin —incluidas las pills del dictado (Pausar, Cancelar, Enviar voz, led, nivel, Transcribiendo y Enviar)— tienen el fondo al 80 por ciento de opacidad y un fondo gris semitransparente; **Dictar** en reposo lleva el mismo estilo que **Escuchar** pero en rojo: borde rojo (`#ef4444`), fondo transparente, palabra e ícono en rojo, `opacity: 0.8` y hover al 30 por ciento. **Escuchar** tampoco tiene color de fondo propio: es transparente; solo lleva `opacity: 0.8` en el botón y el verde al 30 por ciento en hover. **Ajustes** tiene la misma opacidad, más el recuadro negro. **Ajustes** lleva un recuadro negro (`#000000`) como los otros botones.
  - Se guardan como máximo **2 audios por sesión** (el último y el anterior) y **2 sesiones** → 4 archivos en total; se descartan los más viejos.
  - **Sobrevive a recargar:** la caché (archivos + texto + índice) se guarda en `ctx.storage` con el debounce `guardarCacheAudios()` y se restaura con `cargarCacheAudios()` antes de registrar los RPC. Si aun así no hay nada, **Escuchar** se habilita igual: `refrescarVozDisponible` consulta `session.context` y, con un último mensaje del asistente, `repetir` lo sintetiza por `leerTexto` (el camino de contexto, antes solo para sesiones remotas, ahora también en local cuando la caché está vacía).

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
  - Estado compartido de dictado (`opencode-tts-dictando-estado.json`) para bloquear toda lectura y avisos mientras el popup de dictado está abierto. El bloqueo se chequea también en las lecturas "forzadas" (reproducciones desde la caché y textos mandados por `leerTexto`), así ninguna sesión remota puede empezar a hablar encima del micrófono; cada aviso se registra en `voz-remoto.log`.
  - Bloqueo compartido con enfriamiento de 8 segundos (`opencode-tts-trabajando.lock` y `opencode-tts-trabajando-estado.json`, reiniciado con cada mensaje nuevo) para que `"Trabajando."` nunca se reproduzca solapado entre instancias.

## 3. Dictado por voz (STT) y detección automática (VAD)

- **Acceso rápido:** pill **"Dictar"** con el mismo estilo que **Escuchar** pero en rojo: borde rojo bien visible, fondo transparente, la palabra y el ícono (un **redondito rojo** estándar de grabar, en vez de las barras de onda) en rojo, fondo rojo al 30 por ciento al pasar el mouse y relleno rojo al presionarlo o mientras graba, al lado de "Voz". **Ajustes** usa el ícono de engranaje (`settings-gear`).
- **Control desde la barra, sin modal:** al dictar se ocultan las pills habituales y aparecen, en orden, **Pausar / Reanudar** (el **Pausar** usa un ícono propio de **dos palitos**, declarado en `icons`, porque la app no tiene ícono de pausa), **Cancelar**, **Enviar voz**, el **led de audio** y el **nivel de micrófono horizontal de 8 segmentos** (`████░░░░`); en vez de repetir los segundos de grabación (que ya están en **Enviar voz**), muestra la cuenta para el envío automático por silencio (`envío en Ns`, o `cierra en Ns` si todavía no detectó voz); el nivel queda como el botón más a la derecha de la barra. El led muestra un círculo rojo hasta que hay audio transcribible y pasa a verde apenas el VAD detecta voz (200 ms, el mismo momento en que decide que hablaste), recuperado del diseño del modal. La conversación de atrás sigue visible y se puede scrollear; el velo y la capa del diálogo no interceptan la rueda del mouse, y la rueda y las flechas se reenvían al scroll de la charla.
- **Transcribiendo:** durante la transcripción quedan **tres pills** en la barra, en este orden: **Enviar** (deshabilitado y en gris hasta que termine), **Cancelar** (funciona y descarta todo) y **Transcribiendo…** con el ícono de onda. La cuenta **"Enviar en Ns"** arranca recién cuando termina de transcribir, así los botones no saltan tanto.
- **Texto en el compositor:** la transcripción se pega en el cuadro de escritura y aparece **"Enviar en Ns"** (el valor se elige en **Ajustes > Espera para enviar**). Tocar ese pill o editar el texto cancela el envío automático; un clic sin editar no lo cancela, pero mover el cursor con las flechas o enfocar el cuadro sí. Entonces se edita y se envía con Enter. **Cancelar** en esta etapa ya no borra la transcripción: cancela el envío automático, cierra el popup, devuelve las pills a **Dictar** y deja el texto abajo para que lo edites y mandes cuando quieras (durante la transcripción sí descarta todo). Si mandás el texto con el botón de abajo de OpenCode, las pills vuelven solas a **Dictar** en vez de quedar **Enviar / Cancelar** prendidas. Si había un borrador previo, se restaura al enviar. **"Enviar ahora"** permite mandar el texto editado. Los inicios y cortes de la cuenta se registran en `voz-remoto.log`. Se evita la carrera en que un compositor leído vacío al pasar a `confirmar` cerraba el diálogo y el timer después no podía enviar.
- **Errores:** se muestran como aviso (toast), con el detalle copiable desde el propio aviso.
- **Detección de actividad de voz (VAD):**
  - Captura audio con cancelación de eco y supresión de ruido (`echoCancellation`, `noiseSuppression`).
  - Espera a que termine el beep antes de arrancar la grabación y el VAD, salta 500 milisegundos iniciales antes de detectar voz (para que el beep de 320 ms y su cola no prendan el led) y espera 700 milisegundos (con tope en `0.008`) antes de calibrar el piso de ruido para que el eco del beep no suba la vara.
  - **Modo manual:** requiere 200 ms de voz por encima de 2,1 veces el piso de ruido (umbral mínimo `0.006`).
  - **Modo Auto-mic:** requiere 200 ms de voz por encima de 2,1 veces el piso de ruido (umbral mínimo `0.009`).
  - **Cierre sin voz con aviso sonoro:** tanto en dictado manual como en Auto-mic, si pasan 8 segundos sin detectar voz, cierra solo sin gastar cuota y reproduce un beep largo y agudo (`assets/beep-error.wav`) para avisarte aunque estés lejos de la pantalla. También suena si la grabación fue muy corta, volvió vacía o hubo error al transcribir.
  - **Corte automático por silencio:** detiene y transcribe tras el silencio configurado en el selector ▲▼ (5 segundos por defecto, con paciencia proporcional de +1 segundo en dictados de más de 9 segundos y +2 segundos en dictados de más de 20 segundos). Los golpes o ruidos secos de menos de 200 ms que pasan el umbral **no tiran hacia atrás** la cuenta: recién se tratan como voz si la ráfaga se sostiene, así el envío no se retrasa (no afecta al audio grabado). `Enter` corta y transcribe al instante; `Escape` cancela sin gastar cuota.
- **Foco automático:** al cerrar el popup o tocar los pills devuelve el foco al cuadro de escritura (`composer.focus()`).
- **Motores de transcripción con selector en la barra:**
  - Principal: **ElevenLabs Scribe** (`scribe_v3` por defecto, con `tag_audio_events=false` para ignorar ruidos ambientales).
  - Respaldo: **Groq Whisper** (`whisper-large-v3-turbo`).
  - **Ajustes > Motor**: rota entre automático (ElevenLabs y, si falla, Groq), solo ElevenLabs y solo Groq. Se guarda y se sincroniza entre ventanas.
  - Si falta la clave del motor elegido, el popup muestra un error con el nombre de la clave faltante (`ELEVENLABS_API_KEY` o `GROQ_API_KEY`) en lugar de fallar en silencio.
  - Cada intento queda anotado en `~/.local/share/opencode/log/voz-dictado.log` (hora, motor, proveedor, si se envió vocabulario con cantidad de términos y caracteres/keyterms, duración, caracteres y error recortado), que se recorta solo a las últimas 200 líneas.
- **Vocabulario personalizado y comando `/corregir`:** lee `~/.config/opencode/voz-vocabulario.md` (una palabra o frase por línea, ignorando líneas vacías y comentarios `#`), con recarga automática al modificarse. Envía hasta 100 `keyterms` a ElevenLabs y un `prompt` de hasta 600 caracteres a Groq.
  - `/corregir palabra o frase`: guarda el término directamente sin duplicados.
  - `/corregir` o `/corregir lista`: abre un diálogo con el campo para agregar nuevas palabras y la lista completa de términos cargados.
- **Lectura de claves API:** busca `ELEVENLABS_API_KEY` y `GROQ_API_KEY` en variables de entorno o en `~/.hermes/.env`, `~/.config/opencode/.env` y `~/.env`.

## 4. Modo Auto-mic y comando de voz

- **Ajustes > Auto-mic on / off** (gris apagado, verde prendido en el menú; el estado se guarda en `localStorage`).
- **Conversación continua manos libres y envío al hilo de origen:** mientras esté en **Auto-mic on**, espera 400 ms tras finalizar la lectura en voz alta de cualquier respuesta (incluso si escribiste por teclado) y vuelve a abrir el micrófono solo hasta que lo apagues, guardando el `sessionID` del hilo que habló para enviar tu respuesta siempre a ese hilo aunque estés mirando otro.
- **No interrumpe si estás escribiendo:** si detecta que tocaste teclas en los últimos 4 segundos o que ya hay texto escrito en el cuadro del chat, saltea esa tanda sin abrir el popup y mantiene Auto-mic prendido para la siguiente.
- **Espera a que termine la sesión:** antes de abrir el mic consulta `session.active()` en el servidor dueño del hilo; si la sesión sigue trabajando (por ejemplo, tras un comentario intermedio), no abre y reintenta cada 1 segundo hasta que quede libre, con tope de 2 minutos. Así el mic se abre recién cuando terminó la respuesta completa, no en los textos parciales.
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
src/gui.tsx                Pills ("Voz", "Dictar", "Ajustes"), menú de ajustes, VAD, compositor y comandos (GUI)
assets/                    Efectos de sonido (beep.wav, staplebops-01.aac, staplebops-02.aac)
dist/gui-experimental.cjs  Paquete compilado de la interfaz gráfica (generado con npm run build)
```

## 7-bis. Servidores remotos

- **Dictado remoto con claves locales:** el micrófono y la grabación pasan en la app de escritorio; el audio se transcribe con el plugin local usando `ELEVENLABS_API_KEY` / `GROQ_API_KEY` de la Mac. No hace falta instalar el plugin ni cargar claves en el servidor remoto. Si el plugin local no responde, se intenta con el servidor de la sesión.
- **Lectura de respuestas remotas en la Mac:** la GUI se suscribe a `session.text.ended` del servidor remoto, junta el texto y lo manda al plugin local con `leerTexto`, que lo reproduce con `edge`/`say`. Se usó `session.text.ended` porque trae el texto completo; antes se intentaba con `session.idle` y no llegaba.
- **Estado y controles remotos:** en sesiones remotas, el pill **Voz / Pausar voz / Seguir voz**, **Detener**, **Silenciar**, **Dictar** y todo **Ajustes** consultan y comandan al plugin local, que es el que reproduce el audio (el servidor remoto no tiene plugin). Antes, avisar que empezaba el dictado se mandaba al servidor remoto y moría en un `catch`: la voz seguía sonando. Lo mismo pasaba con **Corregir vocabulario** (lista vacía) y con **Voz ON/OFF**; ahora listar/guardar palabras y el estado por sesión se consultan al plugin local.

- **Auto-mic en remoto:** el plugin local lee la respuesta pero no ve los eventos del servidor ajeno, así que nunca emitía `turnoTerminado`. La reapertura del micrófono se dispara con `lecturaTerminada` del plugin local, con la misma lógica (`programarAutoMic`) que en local. Ese evento lleva el `sessionID` de lo que terminó de leerse; la GUI solo abre el mic si coincide con la sesión mandada a leer, para no abrirlo en la sesión activa cuando terminó un audio de otra. Tras enviar con Enter se reenfoca el compositor.
- **Repetir en remoto:** el pill **Voz** busca la última respuesta del asistente en el `session.context` del servidor y la lee localmente; los eventos `session.text.ended` se agrupan por `assistantMessageID` y se usan solo como respaldo. Antes el mapa se pisaba con cada evento y podía leerse el penúltimo mensaje.
- **Sin solapes:** al llegar texto remoto se corta la lectura en curso de otra sesión (según el modo `cortar`/`esperar`) antes de encolar la nueva; los bloques de la misma sesión se encolan sin cortarse.
- **Diagnóstico:** cada paso de la lectura remota queda en `~/.local/share/opencode/log/voz-remoto.log`, con el método RPC `logDiagnostico`.

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
