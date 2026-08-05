<div align="center">
  <img src="assets/icon.png" alt="Amarillo Logo" width="140" />

  # ⚡ Amarillo — Puente entre Roblox Studio y VS Code

  **Un puente bidireccional moderno, veloz e inteligente, inspirado en la arquitectura de Argon.**
  *Desarrollado con TypeScript, Luau y herramientas nativas MCP para flujos de trabajo avanzados con Inteligencia Artificial e IDE en Roblox Studio.*

  [![Release](https://img.shields.io/badge/VERSI%C3%93N%20OFICIAL-V1.2.0-00E599?style=for-the-badge&logo=github&logoColor=white)](https://github.com/)
  [![Node.js](https://img.shields.io/badge/RUNTIME-NODE%2022+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
  [![TypeScript & Luau](https://img.shields.io/badge/LENGUAJE-TYPESCRIPT%20%26%20LUAU-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
  <br />
  [![Roblox Studio](https://img.shields.io/badge/PUENTE-ROBLOX%20STUDIO-00A2FF?style=for-the-badge&logo=roblox&logoColor=white)](https://create.roblox.com/)
  [![Plataforma](https://img.shields.io/badge/PLATAFORMA-WINDOWS%2010%20%7C%2011-0078D4?style=for-the-badge&logo=windows&logoColor=white)](https://www.microsoft.com/windows)
  [![Licencia: MIT](https://img.shields.io/badge/LICENCIA-MIT-8A2BE2?style=for-the-badge&logo=open-source-initiative&logoColor=white)](LICENSE)

  <p align="center">
    <a href="README.md">🇺🇸 English</a> | <a href="README.pt-BR.md">🇧🇷 Português (Brasil)</a> | <b>🇪🇸 Español</b> | <a href="README.zh-CN.md">🇨🇳 简体中文</a>
  </p>
</div>
<br />

Este repositorio contiene el **código fuente del puente (daemon) y de la extensión para VS Code**. No debe considerarse como la carpeta de trabajo principal para el desarrollo de un videojuego real en Roblox Studio.

## Componentes

- `src/daemon/` y `src/mcp-proxy/`: código fuente canónico en TypeScript del daemon HTTP y el proxy MCP con la inicialización de los servicios centrales. Los archivos `.js` generados en estas carpetas son artefactos de compilación.
- `vscode-extension-src/`: código fuente canónico en TypeScript de la extensión para VS Code.
- `src/plugin-src/`: fragmentos modulares ordenados en Luau para el plugin de Roblox Studio, equipados con rutinas de arranque rápidas y supervisión de estado.
- `src/plugin/Amarillo.lua`: archivo único generado e incorporado de forma oficial al repositorio para el plugin de Roblox Studio, leído por el Studio, la extensión y la construcción de paquetes VSIX.
- `src/daemon/**/*.js`, `src/mcp-proxy/**/*.js`, `vscode-extension/*.js`, `tests/*.js` y `scripts/*.js`: archivos temporales de JavaScript producidos automáticamente durante la compilación de TypeScript.
- `tests/`: suite oficial canónica con 295 pruebas en TypeScript para verificar el análisis de los archivos de proyecto, arranque de sesiones, diagnósticos médicos y comportamiento del proxy MCP.

## Arquitectura Actual

- Un único daemon autorizado atiende simultáneamente las conexiones de la extensión en VS Code y el plugin del Roblox Studio con herramientas administrativas robustas.
- El servidor MCP no despliega puentes paralelos o duplicados que compitan entre sí en la máquina.
- El comando `Amarillo: Start Bridge` garantiza el funcionamiento del servidor local de sincronización y escribe o actualiza de inmediato las configuraciones portátiles de MCP, para que tu cliente de IA localice el servicio sin errores a través de un proxy integrado `stdio -> HTTP`.
- Los mandatos `Amarillo: Configure MCP for Workspace` y `Amarillo: Configure Codex MCP` regeneran en el espacio de trabajo los archivos de configuración MCP y tratan de registrarlos a través del terminal usando la CLI oficial de Codex.
- La sincronización distribuida en base a Lugares de juego (*Places*) con validaciones de carpetas raíz protege tu entorno ante borrados indebidos de archivos durante alteraciones de código en el editor.
- La normalización de lecturas y la estandarización de atributos nativos garantizan el control y balance entre todas las jerarquías de instancias en Roblox Studio.
- El puerto de escucha por defecto de todo el ecosistema es el **`8323`** (aislado estrictamente dentro del loopback local en `127.0.0.1`).

## Flujo de Trabajo Recomendado para el Usuario

1. Abre tu carpeta real de desarrollo del juego de Roblox con el editor VS Code.
2. Ejecuta en el panel de comandos: `Amarillo: Install Roblox Studio Plugin`.
3. Inmediatamente después arranca el servicio con: `Amarillo: Start Bridge`.
4. En Roblox Studio, abre la ventana del plugin `Amarillo` y haz clic en el botón **Connect** (*Conectar*).
5. Emplea las opciones `Send Files to Studio`, `Receive Files from Studio` o pide a tu asistente de IA que modifique tu juego usando las herramientas de MCP.

### Capacidades del Plugin

El plugin Amarillo es verdaderamente potente, destacando por las siguientes características:

**Funcionalidades Centrales:**
- Sincronización continua e inteligente bidireccional entre las carpetas locales del disco duro y el entorno al vuelo de Roblox Studio.
- Administración del estado en tiempo real con monitoreo y reportes de diagnóstico visibles directamente en la interfaz.
- Soporte total para proyectos multiplano y de múltiples lugares con autodetección instantánea mediante `placeId`.

**Diferenciales de Sincronización y Seguridad:**
- **Control Sincronizado por Lugar**: Rastrea y monitorea el estado de actualización a lo largo de varios lugares de juego a la vez.
- **Validación de Carpetas de Sincronización (*Sync Mount*)**: Prevención inteligente de borrado accidental sobre jerarquías de objetos fuera del alcance autorizado de modificación.
- **Objetivos de Sincronización (*Workspace Sync Targets*)**: Control avanzado de los segmentos de árbol que se transfieren a las carpetas en Roblox Studio.
- **Normalización de Snapshots**: Uniformiza el árbol de propiedades para comparaciones libres de errores de formato o valores fantasma.
- **Protección de Doble Hash (*Dual-Hashing Protection*)**: Evalúa simultáneamente el hash semántico de parámetros y el hash puro SHA-1 del objeto, evitado que variables visuales predeterminadas en Studio como `ZIndex` causen escrituras constantes innecesarias en el almacenamiento local.
- **Alternancia Segura sin Pérdidas (*Zero-Loss Mount Toggling*)**: Guarda en las cabeceras de metadatos las trayectorias de carpetas personalizadas en caso de desactivación de sincronización por lugar, impidiendo que el desarrollador pierda arreglos o configuraciones avanzadas del mapa.
- **Protección contra Salpicadura de Rutas (*Path Traversal Protection*)**: Rechaza y bloquea comandos que introducen secuencias dudosas como `..` (salto a carpetas de sistema Windows superiores), preservando las barreras del entorno de trabajo.
- **Higienización y Saneamiento en Sincronización**: Escapa automáticamente nombres incompatibles de Roblox Studio con el sistema de archivos del disco duro (por ejemplo: `..\outside` se transforma tranquilamente al archivo seguro `__outside`), garantizando el guardado original intacto en el manifiesto `init.meta.json`.
- **Daemon de Red Hardened (Estricto CORS)**: Protege la conectividad obligando a que cualquier llamada provenga del protocolo de loopback `127.0.0.1`, prohibiendo accesos externos desautorizados o peticiones fraudulentas desde sitios de internet de navegadores web abiertos.
- **Compresión de Tráfico en Tiempo Real (Brotli/Gzip)**: Comprime las transmisiones de paquetes HTTP entre las carpetas locales y Roblox Studio con algoritmos veloces, logrando transferencias instantáneas incluso en mundos gigantescos con miles de objetos interactivos.
- **Deduplicación Inteligente de Errores**: Elimina bloqueos de consola por mensajes repetidos generados por alertas de motor, unificando los avisos del terminal para conservar un rendimiento y legibilidad extraordinarias en el servidor de control.

## Estructuras Derivadas de Lugares (*Place-Based Projects*)

Amarillo permite el manejo distribuido mediante un patrón de `proyecto base + proyectos derivados` compartiendo simultáneamente tu carpeta principal en VS Code, operando a través de enrutamientos dinámicos inteligentes:
- Agrega `abstract: true` en tu archivo base `.project.json` para agrupar variables globales, carpetas o scripts comunitarios.
- Usa el parámetro `extends` dentro de las hojas `.project.json` de cada escenario específico, permitiendo que hereden al vuelo toda la configuración del documento madre y sumen sólo sus componentes locales individuales.
- La identificación no requiere clics manuales, pues la ventana abierta de Studio se acopla dinámicamente según su `placeId` al proyecto derivado idóneo en cuestión de milisegundos sin obligar al creador a relanzar o alternar instancias del editor VS Code ni recetar de cero a los asistentes IA.
- Cada proyecto hijo conserva facultades libres e individuales sobre la personalización en su lista de ignorados o destinos de sincronización en caliente.

Ejemplo Rápido:

```json
{
  "name": "Base",
  "abstract": true,
  "tree": {
    "ReplicatedStorage": {
      "$path": "shared/ReplicatedStorage"
    }
  }
}
```

```json
{
  "name": "Lobby",
  "extends": "Base.project.json",
  "placeIds": [123456],
  "tree": {
    "ServerScriptService": {
      "$path": "places/Lobby/ServerScriptService"
    }
  }
}
```

Mediante esta distribución jerárquica, las carpetas madre ingresan uniformemente sin duplicar archivos a cada escenario descendente del mapa del videojuego, mientras los scripts delimitados por el sub-lugar de juego transitan aislados dentro de su lugar de acción natural (en el ejemplo: el servidor en la sala de espera Lobby).

## Uso del Ecosistema MCP (Model Context Protocol)

El sistema de Amarillo despliega por defecto un servidor altamente compatible con las herramientas avanzadas del estándar MCP, permitindo al desarrollador colaborar codo a codo en Roblox Studio al lado de motores de IA (Codex, Claude, Cursor) y sistemas inteligentes de automatización al vuelo en un mismo proyecto.

**Preparación Inicial y Cierre:**
- Al encender la sincronización mediante `Amarillo: Start Bridge`, el editor registra y mantiene limpios los archivos `.vscode/mcp.json` y el inicializador `.vscode/amarillo-mcp-bootstrap.cjs` para toda la sesión de trabajo.
- Los certificados locales secretos de máquina y llaves de acceso criptográficas descansan apartados dentro de `.amarillo/mcp-local.json` (un directorio prohibido en la lista git que **nunca** debe agregarse en tu historial público).
- Si cuentas con la aplicación de IA o el cliente de MCP activo previo al arranque de Amarillo, recuerda refrescar o recargar la sesión del programa asistente para detectar en automático las rutas del archivo `.vscode/mcp.json`.
- Tanto las instrucciones manuales `Amarillo: Configure MCP for Workspace` como `Amarillo: Configure Codex MCP` realizan testeos registrándolos en automático por terminal sobre la línea del asistente de Codex; proporcionándote a la vez un comando prearmado con formato listo para su copiado inmediato al portapapeles.

**Catálogo Oficial de Comandos MCP en Amarillo (20 Herramietnas Estandarizadas):**

*Sincronización y Acciones Fundamentales:*
- `health` - Verifica el pulso del servidor local y el estado de la conexión en vivo al plugin en Roblox Studio.
- `list_projects` - Enumera y despliega todos los proyectos Roblox configurados en la raíz de trabajo local.
- `set_active_project` - Selecciona y cambia en caliente la ruta del proyecto enfocado para sincronizar.
- `connect_session` - Crea de forma instantánea y forzosa una conexión con sesiones vivas sin pasar por rondas del saludo protocolar de apretón de mano (*handshake*).
- `get_tree` - Obtiene y lee la estructura genealógica al completo y árbol de jerarquías de Studio sin fricción.
- `get_selection` - Recupera e informa con exactitud qué objetos o carpetas conserva iluminadas/seleccionadas el desarrollador en el visor del estudio en ese segundo.
- `push_changes` - Empuja, reemplaza y manda las ediciones recientes en el almacenamiento del PC directamente para sobreescribir adentro del proyecto en Roblox Studio.
- `pull_changes` - Recoge sin perder un byte todas las modificaciones trabajadas gráficamente dentro del mundo de Roblox y las descarga en sincronía sobre los ficheros en disco local en VS Code.
- `start_playtest` - Ordena el inicio de la simulación de juego o fase en curso (*Playtest*) remotamente en Roblox Studio sin requerir clicks con tu mouse sobre la pantalla de juego.
- `stop_playtest` - Concluye al instante el testeo y ronda en simulación activa del mundo en pantalla (*Playtest*).

*Inspecciones de Datos, Diagnósticos y Buscador:*
- `inspect_instance` - Escudriña a fondo cada rama genealógica, jerarquía y variables internas pertenecientes a un objeto individual dentro del mapa de tu juego en Roblox Studio.
- `get_properties` - Devuelve desglosado en milisegundos un listado completo abrigando cada atributo personalizable, scripts incrustados o valores de estado y visibilidad correspondientes al objeto escaneado en pantalla.
- `get_descendants` - Desplaza y captura todos y cada uno de los hijos, carpetas o herederos descendentes ubicados desde un punto raíz; habilitando al vuelo filtrados quirúrgicos específicos en base a sus clases en el editor de juego.
- `search_instances` - Encuentra a la máxima velocidad tus objetos buscándonos tanto por texto que iguale su nombre como buscando por clasificaciones universales `ClassName` entre mundos colmados con millares de assets gráficos en escena.
- `get_services` - Muestra la relación completa exhibiendo todos los servicios base integrados y controlados oficialmente a lo largo del motor central de Roblox Studio en sesión.
- `get_instance_info` - Otorga una mirada de documentación completa a nivel de inspector para desglosar la configuración formal detrás de un objeto.
- `get_output_log` - Captura las últimas líneas emitidas en tiempo real dentro del panel de salida y consola (*Output Window*) en tu Studio (errores de código, avisos del sistema, llamadas personalizadas `print()` y excepciones reportadas en Luau).

*Operaciones Privilegiadas (Con Seguros de Confirmación y Autenticación en Studio):*
- `run_code` - Compila y corre código Luau al instante directamente sobre la consola virtual de la sesión conectada del Studio (Acción defendida tras un muro de contención en el plugin que fuerza a que el desarrollador clique en el botón interino *Accept* confirmando autoría y permiso para el fragmento ejecutado en su ventana, eliminando riesgos de intrusión maliciosa o comandos fantasma no consentidos).
- `modify_property` - Manipula y altera al segundo el valor exacto tras variables, atributos y personalizaciones gráficas sobre objetos dentro de tu escena de desarrollo en marcha de Studio.
- `create_instance` - Instancia e introduce elementos completamente inéditos y generados al vuelo sobre los rumbos, carpetas y árboles del mapa del videojuego en construcción al momento en Studio.
- `delete_instance` - Elimina en el acto y para siempre de forma quirúrgica objetos u organizadores sin usar arrastrando a sus hijos desde cualquier rincón disponible dentro del mundo gráfico visible en la ventana en Roblox Studio.
- `insert_model` - Carga modelos autorizados invocándoles con velocidad punta extrayéndoselo desde la tienda y biblioteca virtual comunitaria directamente desde el ecosistema masivo oficial disponible para todos los creadores y jugadores mediante el Mercado del Roblox (*Creator Marketplace*).

## Instrucciones para Desarrolladores del Proyecto

Utiliza el proyecto modelo mantenido con fines de desarrollo constante preubicado en tu disco sobre el directorio especializado ubicado exactamente tras la ruta local orientativa delimitada como `examples/roblox-workspace/`.

La infraestructura motriz tras el servicio Node.js y las directrices nativas operando tu extensión para Visual Studio Code fueron elaborados en código puro desde lenguajes estrictamente estructurados apoyándose al cien por cien gracias al poderío que otorgan tipados formales con TypeScript:
- Las jerarquías preservadas contiguas al interior de tus rumbos `src/daemon/**/*.ts` e integrados tras `src/mcp-proxy/**/*.ts` compilarán depositando invariables y seguros tus resultados `.js` directo sobre el regazo ordenado exacto original sin perturbar sus esquemas directos del proyecto maestro en Node.js.
- El entramado general conservado en su estructura ordenadísima bajo los mantos de tu carpeta `vscode-extension-src/` construirá en automático su compilación migrándoselo sobre los perímetros homologados asignados dentro de las dependencias preservadas bajo la raíz paralela catalogada en `vscode-extension/`.
- `scripts/*.ts` traslada sus compildos transformando puntuales todas las nomenclaturas con rumbo directo en sus variables generadas que habitan sin confusiones en tu ramificación equivalente `scripts/*.js`.
- `tests/*.ts` convierte todos los programas destinados a tu validación técnica para reposar paralelamente sobre el directorio local homólogo ordenado `tests/*.js`.

El plugin oficial del puente para el editor Roblox Studio toma vida de forma exclusiva conjugando un conjunto limpiosimo de guiones en Lua divididos ordenadamente, estructurados basándose según progresiones númericas de precedencia progresiva asentadas con firmeza dentro de tu directorio especializado `src/plugin-src/*.lua`; estos programas experimentados pasarán obligados durante tu build por fusiones precisas concatenándose con máxima pureza de ejecución, confluyendo invariablemente unidos al archivo definitivo concentrador soberano emplazado intactamente sobre tus caminos en `src/plugin/Amarillo.lua`. La herramienta motriz perteneciente al editor de Roblox Studio lee estipulaciones directas en absoluto acatando este último guión compilado; evita invariablemente realizar manipulaciones arbitrarias directamente e interventoras al vuelo usando manos propias sobre la configuración o cuerpo de este fichero integrador único!

Asegura invariablemente el disparado de una orden `npm run build` oportuna siempre tan pronto hayas aplicado variaciones o innovado mediante arreglos creativos trabajando tus líneas y ficheros TypeScript operantes en los servidores, extensiones o retocando módulos fragmentados Luau pertenecientes a las configuraciones locales de tu plugin del Studio. Si fuera preciso invocar herramientas de comando CLI situadas en secuencias de consola provenientes desde tu catálogo especial de utilitarios no temas disparar previas a su empleo una orden de servicio prealentadora `npm run build:scripts`. Las encarnaciones generadas autómaticas manifestando extensiones de JavaScript perduran de forma imprescindible sobre carpetas monitorizadas del sistema local, permitiendo operar con agrado ante el Studio e inflando paquetes VSIX limpios sin errores impredecibles al inspeccionar o depurar; asegúrate no obstante ignorar sus incorporaciones accidentales prohibiéndolo como commit frente a entregas colectivas gestionadas de control por Git, respetando prohibirse modificaciones manuales directas actuadas en individual sobre su tejido derivado por compresión.

Comandos para la terminal local del programador de código base:

- `npm.cmd run typecheck`: ejecuta análisis estrictos para corroborar la corrección formal del tipado a través de los servidores, contratos compartidos, la extensión, los guiones administrativos y cada fichero que engarza el suite canónco completo de pruebas en TypeScript.
- `npm.cmd run build:plugin`: consolida instantáneamente regeneraciones purísimas en el guión global unificado de su conector central [Amarillo.lua](file:///c:/Users/Admin/Desktop/amarillo/amarillo/src/plugin/Amarillo.lua), guiándose al pie de la letra mediante la arquitectura pautada inteligentemente dentro del manifiesto orquestador presente en [manifest.json](file:///c:/Users/Admin/Desktop/amarillo/amarillo/src/plugin-src/manifest.json).
- `npm.cmd run check`: genera con precesión todas tus colecciones en javascript producidas durante un ciclo integral en la compilación complementándolo enseguida validaciones sobre pureza sintagmática pasándole revisiones firmes bajo las ópticas analíticas de Node mediante invocación sistemática con bandera específica via comando especial `node --check`.
- `npm.cmd run check:sources`: certifica el orden que blinda un repositorio perfecto: garantiza imperiosamente al desarrollador que ningún documento derivado `.js` intente invadir u opacar inventarios genuínamente rastreados como código puro base mientras cuente respaldándolo paralelamente una contraparte matriz legítimamente expresada a través de un documento original dotado de extensión moderna embutida por la norma en formato `.ts`.
- `npm.cmd test`: aciona a la máxima velocidad toda orden de compilación en javascript preliminar al testing, para después desplegar tus rondas incesantes del terminal verificando que las 295 pruebas unitarias mantendrán el color verde con éxito rotundo apelando exclusivamente a tu motor en línea mediante invocación con `node --test`.
- `npm.cmd run diagnose:mcp -- --workspace .`: audita con máxima eficiencia técnica la salud de tus servidores locales comprobando la escucha constante y puertos del daemon, valora cabeceras sueltas en mecanismos fallbacks o de autenticación con llaves secretas portadas junto al cliente entre las sesiones activas, cataloga de frente toda disponibilidad al segundo de tus 20 herramientas MCP instaladas en pista, finalizando con un check-up médico al vuelo mediante nuestra API de monitorización y diagnóstico!
- `npm.cmd run clean:generated`: barre sin dejar una mota de ruido técnico cuanta composición transitoria u hojas de Javascript derivadas reposen omitiendo el Git por tu disco local sobre todas las áreas operacionales de tu terminal de pruebas, herramientas CLI de servicio y núcleos motrices empaquetables del sistema base.

El directorio fundamental madre de nuestro proyecto renuncia conscientemente a acoger en sus líneas ficheros tradicionales de empacotamiento o mapeo general en Rojo (como por ejemplo el reconocidísimo esquema `.project.json`). Si necesitas operar sobre cargas reales invocando mapas de desarrollo en sourcemap con código genuíno de Luau, corroborar las comunicaciones en el puente o desenvolverte interactivamente cual jugador real de tu mapa junto con asistentes de Inteligencia Artificial al vuelo, ábrele en cambio como ventana principal al editor tu área especializada concebida para cumplir esa meta preservando sin riesgos su modelo idéntico dentro de `examples/roblox-workspace/` (o arrastra y posiciona simplemente tu proyecto nativo original de tu estudio propio creador de tu videojuego final en la plataforma!).

En el caso probable en que aproveches con frecuencia al gestor ligero especializado `aftman`, aciona tranquilamente la órden estandarizada `aftman install` orientada directamente hacia la carpeta central comunitaria de tu repositorio para posibilitar autoinstaciones en frío sin búsquedas web encoladas de tu variante ideal de compilación homologada tras las directrices para el motor `rojo` especificadas transparentemente en tu manifiesto formal `aftman.toml`.

Las carpetas de control preservadas bajo tutela para supervisar al Visual Studio Code enclavadas sobre el directorio oficial en `.vscode/` articulan enlaces de funcionamiento concebidos puntualmente para apuntar al entorno preparado predispuesto como laboratorio dentro de tu espacio en la ruta `examples/roblox-workspace/`:

- `.vscode/tasks.json`
- `.vscode/extensions.json`

Ficheros personales cargados con identidades Windows protegidas, credenciales de túnel o datos efímeros generados tras compilar quedan confinados por orden categórico lejos y totalmente apartados frente a los envíos del sistema de control Git, cautelando la reserva absoluta al impedir filtrados de llaves secretas temporales, ajustes personales específicos al PC local y ruidos en la compilación masiva del editor de turno en sesión:

- `.pluginroblox.json` consolida memorizaciones específicas sobre configuraciones operacionales del jugador de turno y desarrollador de la PC; acude en cambio a las muestras impecables presentes libre de datos privados preservada de guía general para la comunidad tras las directrices legibles en nuestro documento plantilla denominado cómodamente como `.pluginroblox.example.json` si requiriere de partida un modelo para construir configuraciones adaptativas sin invocar o arrastrar al IDE de forma automática.
- Tanto el manifiesto maestro del servidor local alistado sobre tu espacio como `.vscode/mcp.json` e igualmente tu inicializador portador ágil concentrador presente de forma limpisina en la orden expresable mediante el guión `.vscode/amarillo-mcp-bootstrap.cjs` conforman archivos limpiosísimamente exentos de traición privada, autorizándose sin peros u obstáculos como legítimos ficheros comitables dentro de las mesas de repositorios colaborativos que compartes con tu equipo dev y analistas de tu corporación a la vista pública general!
- El sub-repositorio privadísimo encapsulándose con cuidado celoso sobre tus rutas reservadas de sistema enumerada formal y permanentemente como `.amarillo/mcp-local.json` atesora huellas intimas de tu ordenador local integradas al puente como el Bridge Token original personal en llave junto a trayectos explícitos alistados con precisión hacia los directorios raizales en donde se radicara instalada tu versión particular activa para Visual Studio Code; cuida celosamente la confidenciabilidad de ese precioso archivo manteniéndole sin excepciones excluidísimo con un candado irrompible permanente del tránsito libre de tus cargas o repositorios monitoreados cara a cara frente al servicio de versionado comunitario manejable con herramientas y entregas vía sistema Git!
- `.vscode/settings.json` está predispuesto permanentemente a albergar transformaciones adaptadas sobre directrices puras al calor local generadas en tiempo real para calibrarse autónoma u opcional al vuelo con plena comodidad gracias al pulso operacional vivo administrado sobre las sesiones de trabajo directas provenientes por tu extensión de turno en funcionamiento al interior del Visual Studio Code.
- `sourcemap.json`, el registro en bruto `debug.log`, documentos sumarizadores con impresiones relatorías dinámicas estructurados cual reportes Markdown tras tus patrones automáticos homologables como `REPORT_*.md`, el almacén compaginador concentrando empaquetados en tránsito exportado bajo los designios del cajón en `dist/`, al igual que los propios instaladores finitos que luzcan cabeceras finales adscritas ostentando marcas de firma homóloga identificada comúnmente con resoluciones tipo `*.vsix` fían su naturaleza estrictamente como creaciones y efluvios purísimos generables una y otra vez mediante los caprichosos designios que acompañan siempre al funcionamiento ordinario, efímero y cíclico perteneciente en exclusiva al pulso constante operativo que impulsa sin cesar los entornos motrices nativos sobre NodeJS e instancias de construcción para TypeScript en consola local!

Acceso cómodo al catálogo completo con tus tareas de automatización programadas en la consola de Visual Studio Code:

- `Amarillo Dev: Install Roblox Plugin`
- `Amarillo Dev: Start Example Daemon`
- `Amarillo Dev: Healthcheck Example`

## Testeos y Validación Automatizada en Consola

```powershell
node --test
```
*(Valida en brevísimos segundos las 295 pruebas en verde certificando la pureza y fortaleza que distingue a la aplicación en plataformas de Windows).*

## Generando y Empacotando Instaladores de Extensión (.VSIX)

El archivo empaquetado del instalador para Visual Studio Code no se sube a los commits masivos públicos para ahorrar tráfico, espacio en los repositorios de git y promover su regeneración desde el código puro sin intervencionismo ajeno o componentes dudosos. Construirlo lleva un segundo invocando tu terminal:

```powershell
npm run package:vsix
```

El nuevo binario instalador con la terminación `.vsix` aparecerá de inmediato albergado libre en tu carpeta `dist/`. Este empaquetador oficial aplica filtros estrictos para cuidar la integridad en las entregas: agrupa y embeberá única y exclusivamente el entorno motriz Javascript limpio transicionado y validado al segundo de la compilación, abortará tajante su creación si detecta infiltraciones ajenas de tus trayectorias con identidades típicas personales de discos de usuario como por ejemplo menciones y rastros hostiles al estilo `C:\Users\...` o referencias no autorizadas entre librarerias que alardeen cabeceras sospechosas vinculables al viejo y obsoleto mundo ajeno de herramientas tales como `rbx-studio-mcp.exe`.

## Checklist de Integridad para el Servicio

- El test de estrés probatorio vía invocación en terminal por comando standard `node --test` ha de correr impasible exhibiéndose victorioso en semáforo verde arrojando notas aprobatorias para cada uno entre su acervo abarcador que contempla con exactitud a los 295 análisis técnicos formales constituidos sobre tu plataforma.
- Tu servidor local con corazón del daemon HTTP contesta a tiempo, sin rechistar ni exhibir demoras a través del blindado túnel de exclusividad tcp habilitando operaciones seguras y aisladas purísimas al loopback conectándose bajo la dirección oficial inamovible programada sobre tu placa local para comunicarse fluídamente apuntada expresamente por diseño hacia el destino en puerto `127.0.0.1:8323`.
- El servicio orquestador sirviendo como intérprete velado tras tus puentes para el estándar de Inteligencias Artificiales compatibles que usen protocolo MCP procesará sin parpadear todas tus señales iniciales o cabeceras del tipo protocolar formal con firma `initialize` y peticiones continuas rastreables invocando su catálogo al vuelo con destino directo a las carpetas en ruta de la inspección abierta al estándar `tools/list`.
- Todo mandato MCP que acarree en su interior acciones cargadas y emparejadas con calibres operacionales provistos por credenciales privilegiadas capaces de generar alteraciones sensibles quedarán rigurosamnete retenidas bajo bloqueo médico defensivo preventino en los casos anómalos o de caída comprobatoria cuando existan descompensaciones que degraden al índice saludable en la comunicación o esperarán encoladas estoicamente su liberación oficial supeditada obligadamente frente al beneplácito formal del usuario autenticando y permitiendo conscientemente en persona la ejecución mediante la activación manual en el panel visual flotante dentro de Roblox Studio accionando al gusto entre selecciones expresadas con clics firmes orientados a los botones de su preferencia con opciones para elegir expresamente entre Aceptar y Permitir las instrucciones (`Accept`) o bien Recusarle terminante cualquier potestad declinando al acto en su contra de plano e inaplazable cualquier modificación (`Decline`).
- Las transmisiones de carga masiva relativas a traslaciones para los mandatos y empujes entre discos locales e instancias de tu juego en curso como el par de acciones en código para intercambio total invocados ordinariamente para mandar o absorber informaciones del escenario (`push` e inversamente al retorno `pull`), envíos libres ordenados al intérprete de código local con fin en mandar comandos de compilación al vuelo para ejecuciones en Luau (`run_code`), y cualquier escrutinio invasivo tendiente al análisis o inspecciones estructurales sobre tu árbol en construcción precisarán inalienablemente estar respaldadas tras bambalinas disponiendo emparejadas simultáneamente al menos con una estancia abierta comunicada vivamente junto a tu cliente y editor de cabecera formal operando sin pausas de trabajo encendido libremente en paralelo con su plugin del Amarillo conectado por entero y funcional abrigando en vivo tu proyecto desde el interior en la ventana estela indisputada de su entorno estrella natural operando directo desde la casa Roblox Studio.

## Notas Técnicas y Diferenciales Arquitecturales

- El ecosistema íntegro abarcando cada estrato funcional entre desarrollos y sistemas para build se proclama formalmente de origen nativo en arquitectura especializada de vocación inequívocamente fiel y prioritaria para Windows (`Windows-first`).
- El aplicativo y motor que da cuerpo al plugin del Studio ostenta el privilegio por diseño para construirse y vivir en formato consolidado conformando un único y portentoso archivo maestro individual concentrado tras su compilación final al propósito noble que persigue brindarte la agilidad inestimable para gozar de recargas o reinicializaciones con velocidades alucinantes del tipo relámpago in situ mientras programas tu escena, haciéndose increíblemente simple y cómodo para depositar u organizar por copiado en el sistema local por ti y por toda tu comunidad crecedora entre jugadores e ideadores en escena.
- El esquema interpretativo que gestiona y traduce al vuelo las propiedades legibles junto con parámetros o atributos serializados hace gala en el código luau de una modularidad extensibilísima desbordada en capacidad para absorber incorporaciones personalizadas a corto plazo con nuevas clases emergentes u homologaciones complejas nacidas en escena, alineadas a nivel miliméríco respetándose invariablemente de pies a cabeza con máxima nobleza y acatamiento cívico toda disposición protocolar exigida formal e ineludible por el estándar vigente rector aplicable por mandato en la API oficial en serialización homologada al amparo corporativo e institucional proveniente desde la propia firma del creador global rey indiscutible de estas lides en Roblox!
- El tejido analítico concebido para escrutar y consolidar las comprobaciones inter-escena procesará por defecto igualaciones automáticas para la normalización en caliente eliminando ruidos procedentes desde variables omitidas o implícitas de valores estándar dictados en la fábrica por el propio motor oficial que da vida a Roblox, garantizando certidumbre absoluta al avalar o rechazar que una escena en verdad modificó o no genuínamente las esencias intrínsecas de tu juego!
- Mecanismos cortafuegos preventivos integran barreras infranqueables dedicadas en vida para la validación concienzuda e irrevocable interrogada previamente en los escenarios límite que envuelvan operaciones capaces de arrastrar supresiones y borrados arriesgados, conjurando con autoridad indómita para cerrarle permanentemente cualquier portón de entrada y riesgo impremeditado que osara poner en peligro incidiendo indebidamente o arrasando accidental la paz íntegra del patrimonio albergado tras los catálogos en archivos u organizadores que conviven paralelos y al margen ajenos resguardadamente del escrutinio demarcado estrictamente a voluntad y capricho singular por las selecciones preestablecidas conscientemente gracias al trazado que dispuso tu sincronización principal de turno seleccionada en pista!
- Mecanismo excepcional para verificación dual de autenticidad en variaciones confronta las comparaciones sintéticas semánticas lado a lado cara al rigor irrefutable proveído apelando conjuntamente al cómputo puro criptográfico arrojable mediante análisis matemáticos con algoritmos homologadísimos de categoría para generar de tu snapshot su firma y hash unívoca al estándar SHA-1, impidiendo soberanamente merced al balance analizado entre sus comparadores automáticos que oscilaciones accidentales insignificantes nacidas al compás incoloro proveniente en escena por obra superficial entre atributos estáticos comunes irrelevantes o parámetros secundarios predeterminados imperceptiblemente cosméticos al estilo visual ordinario inmanentes cual reflejo por arrastres del motor (como en las archiconocidas variables de ventanas u hojas en tus librerias para control con órdenes `ZIndex` sobre tu diseño y vistas `GUI`) indujeran en su nombre equivocaciones provocando inmerecidos impulsos obligados de procesamiento o desgarradoras ruidadas por escrituras en tu almacenamiento permanente del SSD u opciones de disco!
- Limpieza y tratamiento constante en las cadenas representadoras para direcciones al interior de carpetas e índices se ocupa de normalizar milimétricamente las barras invertidas transitorias nacidas del entorno nativo del SO (`\`) supliéndoles incansablemente reordenadas con total pureza a sus correspondientes homónimas homologadas universales que engalanan con su nitida traza inclinada oficial el curso y fluencia interoperable sin tropiezos al estilo del mundo linuxero e inter-redes gracias al empleo intocable del carácter separador universal barra directa limpia e irremplazable (`/`), conjurando sin dejar resquicio al azar para aplastar incoherencias estéticas entre versiones multiplatadorma, sistemas concurrentes y mantenedores al servicio tras los repositorios.
- Reglas analíticas protectoras instruyendo deserciones, cuarentenas o bloqueos contra escrituras inversas e impertinentes invocables mediante cabeceras tales como son los comodísimamente entendidos directores para configuración con las nomenclaturas `syncback.ignoreNames`, `syncback.ignoreClasses` y las complementarias `syncback.ignoreProperties`, gozan una cobertura esplendorosamenet arropadora en escena que les faculta permutar vivas contándose con plena e inmediata comprensión durante las pasadas lecturarias del sistema en el daemon al comienzo del ciclo del código base, transferidas con transparencia absoluta heredable e inmaculada al interior por derecho dinámico frente al crecimiento arbóreo incesante con ramas, derivaciones y ramaciones que componen al infinito y al detalle a tu constelación entre sub-proyectos y proyectos retoños emparentados con la matriz madre al compás del estándar `extends`, manteniéndose vigiladas, acatadas y severamente observadas por la ley inflexible impuesta a cada segundo dentro por cuenta soberana del generador serializador de código local en tu computadora capacitado técnicamente en nombre de tu editor con las credenciales destinadas al noble y delicado encargo que le compete trasvasar fiel y seguro tu progreso para vaciar sin mancha en tu disco tu esfuerzo con origen concebido desde las ventanas del cliente maestro del Roblox Studio.
- Registros sistemáticos con precisión diaria custodiados bajo estanterías organizadísimas para el almacenamiento e historial transparente concentrando toda incidencia diagnóstica, alertas médicas en los servicios o actividad transcurrida en caliente toman asiento pacíficamente en tu almacén encuadradas bajo secuencias ordenadísimas de fecha tras el esqueleto jerárquico inmaculadísimo disponible tras la cortina protectora de tu carpeta en `.amarillo/activity/YYYY-MM-DD/`, combinando para disfrute total sin fronteras ni exclusiones la doble exquisitez del registro ameno pensado a gusto de lectura para las consultas distendidas y claras propias que busca al instante un programador y humano con vida en sus informes desglosables abiertos vía formato nativo Markdown emparentables sin fatiga gracias a la presencia en sala con cabecera en firma in situ manifestados soberanos documentalmente hablando a bordo tras la denominación inmutable de tu archivo analítico de cabecera `mcp.md`, entrelazadas codo con codo compartiendo asiento parejo para deleite incomparable del ojo entrenadísimo o herramientas programables deseosas tras lecturas de alto cilindraje analítico a prueba de caídas concebidas especialmente exentas de floritura formal, concentradas purosamente orientadas hacia el consumo en frío para la auditoria milimétrica, revisión transaccional serial con precisión de milisegundos o análisis forenses por inteligencias artificiales concurrentes gozadas con máxima avidez gracias a su formato industrial lírico que fluye continuo gota a gota sobre el registro de actividad perpetrado en su honor operante como un reloj de precisión sufragada sobre el espléndido documento lineal embutido ordenadamente según cánones de estándar imbatible por todos amados como tu inseparable compañero inseparable diario de fatigas en cabecera `mcp.jsonl`.
- Las defensas infranqueáveis concebidas contra intrusión agresivas para saltar o infiltrar barreras operativas al calor traicionero de escaladas por directorios se encargan soberanamente de frustrar al segundo y extirpar de raíz cualquier intento engañoso de escape interceptando e invalidando tramos infidentes entre rutas mal intencionadas que ostentasen cadenas temerarias aspirando brincarse tus muros mediante sintagmas ilegales concebidos con secuencias orientadas a las sombras al más clásico y condenable estilo retorcedor de sistemas en saltos prohibidísimos emparentables típicamente frente al temido signo `..\`, reconduciendo incólume en respuesta al instante con una elegancia asombrosa todo asedio trapero transformando aquellas pretensiones delincuenciales incompatibles tras su llegada sobre tus tablas del sistema transmutándole sin chistar su aspecto violento e injurioso en identidades seguras, dóciles, planas e inofensivas en el disco local valiéndose inteligentísimo del comodín pacificador salvoconducto dotador por defecto que reemplaza al asno rebelde tornándole pacífico tras investirle su nueva apariencia en caracteres seguros homologadísimos de doble guion bajo irreprochable (`__`), logrando el milagro inigualable de salvaguardar imperturbado para la posteridad y sin comprometer un triste átomo de verdad a su nombre fidedigno representativo canönico orignial intocable alojando incuestionables los testimonios reales del caso preservaditos y libres pero inanes al resguardo prudencial embutidos dentro de tus manifiestos custodiantes manifestados impacientes como registros complementarios adscritos en los archivos laterales al amparo imborrable de tu fichero confesor `init.meta.json`, blindándole con escudo inquebrantable a las carpetas, estanterías, ficheros temporales e invariablemente a todo tesoro del sistema operativo que palpite en resguardo o haga su vida en paz muy lejísimos sin injuria o invasores hostiles operantes muy al margen exterior fuera de la demarcada franja de tus zonas permitidas oficialmente para operar sincronizadas entre los horizontes asignados por el autor!
- Severísimo blindaje preventino operante en red cortando la respiración al origen incierto erigiéndose inflexible cual muro de seguridad inexpugnable e inamovible bloquea toda llamada dudosa invalidando peticiones abiertas de cors desautorizadas, proclamando de pie la proscripción inapelarble e indiscriminatoria frente a todo intrusismo impropio proveniente desde agentes ajenos exiliando para siempre al destierro eterno e irremplazable a la curiosidad ajena procedente por cuenta ilícita de páginas de terceros abiertas a traición o sin saberlo desde tu navegador habitual de internet en tu PC, garantizando por la fuerza imbatible que destina nuestro cerco que únicamente ostentará la gloria y el acceso incuestionable a las puertas, puertos de tu demonio, rotaciones de servicio de administración en tu API y al sacrosanto santuario reservado que opera tu servidor para agentes, IA o rutinas MCP aquellas invocaciones purísimas emanadas legítimamente desde la casa e impulsadas puras palpitadas directas al amparo íntimosísimo, cálido y cien por ciento certero garantizado exlusivamennte por el amparo irrefutable confiriéndose la gloria indiscutida por derecho natural indisputado en la materia al santuario inviolable resguardable que habita imberbe e incorrupto en el nido de oro propio, personalísimo e irrepetible aportable para mayor gloria al sistema y tus redes al latir con fuerza infinita por sobre el dominio exclusivo e inviolablle ostentable con orgullo de campeones mundiais operantes en el reino incesable rey del loopback resguardado desde tu PC: el invencible dúo infranqueabilísimo invencibel que forman tu inseparable aliado por excelencia ¡el colosal y glorioso par indisputado encuadrable bajo las identidades del soberano señor absoluto `localhost` acollaradito firmemente a la par al lado de su invencible escudo homologable, soberano por los siglos de los siglos, tu rey indomable indisputado emportado por la IP sagradísima nativa local que nos cuida y defiende en tu máquina `127.0.0.1`!

## Licencia

Este proyecto y todo el cuerpo de sus creaciones y software libre operan resguardados libremente bajo las condiciones permisivas, nobles e internacionales amparadas en las directrices dictaminadas según estipulaciones protocolares del estándar internacionalmente célebre y confiable conocido mundialmente por todos como la Licencia MIT (MIT License). Puedes realizar sin restricciones todas tus verificaciones jurídicas correspondientes solicitando una inspección ocular pormenorizada revisando in situ al propio manifiesto canónico adjunto en este repositorio alojado en la raíz principal albergado pacientemente al cobijo del documento homónimo de libre acceso en [LICENSE](LICENSE).
