# Pendientes e ideas — opencode-voz

## Lo que ya está hecho y andando

- Lectura en voz alta con `edge-tts` (respaldo `say` en macOS).
- **Sesiones remotas:** dictado transcrito en la Mac con claves locales; respuestas del servidor leídas en la Mac vía `session.text.ended` + `leerTexto`; pills **Voz / Pausar voz / Detener / Silenciar** y repetición apuntando al plugin local; sin solape de audios entre sesiones. No hace falta instalar el plugin en el servidor remoto.
- **Dictado sin modal:** controles en la barra (nivel horizontal de 8 segmentos, segundos, Pausar/Reanudar, Cancelar, Enviar voz), ocultando las pills normales mientras se dicta; el texto va al compositor con cuenta regresiva cancelable y se preserva el borrador previo.
- Lectura en streaming oración por oración + pre-generación en paralelo.
- Trabajadores persistentes (Python `edge_tts` + JXA `AVAudioPlayer`) con precalentamiento al enviar mensaje.
- Pausa y reanudación en el milisegundo exacto con `AVAudioPlayer`.
- Pill **"Voz ON / Voz OFF"** por sesión a la izquierda de la barra (verde en ON, ámbar en OFF): apaga por completo lectura, avisos, Auto-mic y dictado solo en esa sesión (escondiendo las demás pills, cortando de inmediato su reproductor y oraciones en cola incluso entre instancias, y sin cortar el audio de otras sesiones activas), guardado en el servidor por sesión.
- Pill **"Voz"** arriba del cuadro de escritura:
  - Gris ("Voz"): repite el último mensaje leído al instante.
  - Verde ("Pausar voz"): pausa la reproducción.
  - Rojo ("Seguir voz"): retoma desde donde quedó.
  - Gris ("Voz apagada"): vuelve a activar la lectura.
- Avisos cacheados de actividad: "Trabajando" tras 3 segundos desde que termina `"Tú: …"` y luego cada 30 segundos si no hubo actividad (con bloqueo compartido entre instancias para que no se solape ni pise una lectura en curso), herramientas ("Usando Leer", "Usando Terminal", etc.) espaciadas 3 segundos desde el fin del audio anterior, "Permiso pendiente" cuando OpenCode pide autorización y confirmación hablada de tu respuesta ("Permitido una vez", "Permitido siempre" o "Permiso rechazado").
- Confirmación hablada al enviar un mensaje: lee `"Tú: "` seguido del texto del mensaje con la voz contraria a la del asistente (si el asistente habla con Carlos, tu eco sale con Dalia, y al revés), sin pisar el último mensaje del asistente y omitiendo bloques/líneas de código, capturas completas de terminal Linux/SSH y macOS (`usuario@host:ruta$`), salidas en columnas (`systemctl`, `free -m`, etc.) y páginas HTML pegadas, siempre antes de `"Trabajando."`.
- Pill **"Eco"** global a la derecha del motor (verde prendida, gris apagada, sincronizada entre instancias): al apagarla silencia el eco del usuario (`"Tú: …"`), `"Trabajando."` y los avisos de herramientas, dejando solo las respuestas del asistente y `"Permiso pendiente."`.
- Repetición del último mensaje separada por sesión (hasta 20 charlas) para que apretar **Voz** en una sesión nunca reproduzca el mensaje de otra.
- Selector de género de voz con pill **"Fem / Masc"** a la derecha de Auto-mic (gris en Fem, ámbar en Masc; Dalia `es-MX-DaliaNeural` y Carlos `es-HN-CarlosNeural`, con respaldo `Mónica` y `Jorge` en `say`), guardado y sincronizado entre instancias.
- Coordinación global de audio entre sesiones con comando `/cortar` (y variable `OPENCODE_TTS_CONCURRENCIA`): por defecto en modo **cortar** frena al instante cualquier lectura anterior incluso entre proyectos distintos (sin mezclar voces ni caer al respaldo `say`); al repetir `/cortar` cambia a modo **esperar turno**, sincronizado entre instancias.
- Dictado por voz (STT) con pill **"Dictar"** con borde rojo bien visible (fondo transparente en reposo, relleno rojo al presionarlo o mientras graba) al lado de "Voz" (sin atajos de teclado globales):
  - Corta y bloquea la voz del asistente mientras el dictado está abierto (coordinado entre instancias), pide el micrófono en silencio y apenas está listo abre el popup junto con el beep para grabar sin demora.
  - Popup unificado con fondo suavemente translúcido (72 por ciento) y texto al 100 por ciento de nitidez sin oscurecer el chat: muestra punto rojo animado, contador (`00:00s`, `00:01s`, …), **semáforo de audio utilizable** (rojo → verde a los 400 ms de voz sobre umbral), **selector numérico ▲▼** (1 a 20 s, guardado en `localStorage`, por defecto 5 s) que ajusta a la vez la espera de silencio del VAD (con paciencia proporcional +1s/+2s en dictados largos) y la cuenta regresiva de envío, barrita de nivel de micrófono, botón **Pausar / Reanudar** durante la grabación, cargador mientras transcribe, vista de error copiable si falla la API y confirmación final.
  - Al cerrarse el popup (o tocar los pills), devuelve el foco al cuadro de texto (`composer.focus()`) para que Espacio no dispare Dictar por accidente.
  - Cancelar en cualquier momento con Escape o Cancelar (sin transcribir ni gastar cuota).
  - VAD (corte automático por silencio): espera a que termine el beep antes de grabar, salta 250 ms iniciales antes de detectar voz y espera 600 ms (con tope en `0.008`) antes de calibrar el piso de ruido, pide el micrófono con `echoCancellation` y `noiseSuppression`, exige 200 ms reales encima de 2,1 veces el ruido (umbral mínimo `0.006` manual / `0.009` Auto-mic) para detectar voz, cierra solo a los 8 segundos con beep largo y agudo si no detecta voz (en manual y en Auto-mic), y corta tras 5 segundos de silencio (paciencia adaptativa hasta 7 segundos en dictados largos). Enter sigue cortando al instante.
  - Modo **Auto-mic on / Auto-mic off** con pill al lado de "Dictar" (gris apagado, verde prendido, guardado en `localStorage`): mientras esté prendido, tras terminar la lectura en voz alta de cualquier respuesta (incluso si escribiste con teclado), espera 400 ms y vuelve a abrir el micrófono solo recordando el `sessionID` del hilo que habló para enviar siempre ahí aunque estés mirando otro; si detecta que estás escribiendo en ese momento o hay texto en el cuadro del chat, saltea esa tanda sin interrumpirte; si pasan 8 segundos sin detectar voz cierra solo con beep largo sin gastar cuota, y si dictás `"dejar de escuchar"` o `"deja de escuchar"` suena el beep largo y apaga Auto-mic automáticamente sin mandar ese texto al chat.
  - Sonidos reales reproducidos con `afplay`: `assets/beep.wav` (910 Hz, 320 ms) al abrirse el popup de dictado, `assets/beep-error.wav` (1450 Hz, 650 ms) cuando no detecta voz, al apagar Auto-mic por voz o si falla la transcripción, `assets/staplebops-01.aac` al cortar la grabación del dictado, y `assets/staplebops-02.aac` al enviarse el dictado y al terminar de leer cada respuesta.
  - Transcribe con ElevenLabs Scribe v3 (`scribe_v3`, con `tag_audio_events=false` para ignorar ruidos como `[golpe seco]`) o con Groq Whisper (`whisper-large-v3-turbo`), elegible con la pill **"Auto / Eleven / Groq"** a la derecha de Fem/Masc: automático (ElevenLabs y, si falla, Groq), solo ElevenLabs o solo Groq, guardado y sincronizado entre ventanas.
  - Si falta la clave del motor elegido, el popup muestra el error con el nombre de la clave faltante (`ELEVENLABS_API_KEY` o `GROQ_API_KEY`) en vez de fallar en silencio.
  - Cada intento de dictado se anota en `~/.local/share/opencode/log/voz-dictado.log` con hora, motor, proveedor, si se envió vocabulario (términos y caracteres/keyterms), duración, caracteres y el error recortado (se recorta solo a las últimas 200 líneas).
  - Vocabulario personalizado en `~/.config/opencode/voz-vocabulario.md` (envía hasta 100 `keyterms` a ElevenLabs y `prompt` de hasta 600 caracteres a Groq; se recarga solo) con comando `/corregir palabra` para agregar al instante y `/corregir` o `/corregir lista` para ver todas las palabras guardadas y sumar nuevas.
  - Lee la clave desde variables de entorno o `~/.config/opencode/.env`.
  - Confirmación en el propio compositor: el texto se pega abajo con pill "Enviar en Ns" (mínimo 2 segundos); tocarlo, escribir o hacer clic cancela el envío automático y se manda con Enter. El borrador anterior se restaura al enviar.

## Próximos pasos e ideas

1. **Configuración visual en la app (Ajustes o menú del pill):**
   - Elegir voz de `edge-tts` y velocidad sin variables de entorno.
   - Elegir si "Dictar" manda directo, abre popup de confirmación o pega el texto en el cuadro de escritura para revisar antes de enviar.
   - Elegir el idioma del dictado desde la app (hoy se cambia con `OPENCODE_STT_LANG` o `OPENCODE_STT_GROQ_LANG`).
2. **Arranque aún más rápido (opcional):** evaluar motor TTS local neuronal (p. ej. Kokoro o Piper) o voces Enhanced/Premium de macOS para bajar el arranque de ~1,1 s a <0,3 s sin depender de internet.
3. **Multiplataforma (opcional):** agregar soporte de reproducción/pausa para Linux y Windows además de macOS.

## Notas técnicas

- Vocabulario de dictado: `~/.config/opencode/voz-vocabulario.md` (editable sin reiniciar).
- Nota tras `/reload`: OpenCode tarda unos 3 segundos en terminar de recargar el plugin; esperar ese momento antes de abrir el popup para que la recarga no cierre la ventana vieja.
