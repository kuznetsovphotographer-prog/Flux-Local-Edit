# Установка в конкретную portable-сборку Photoshop

<a id="portable-scope"></a>
## Для какого случая эта инструкция

Подтверждённый случай автора: **Windows, Photoshop 27.8**, запуск через `C:\Photoshop\PhotoshopPortable.exe`. Creative Cloud не требуется для описанного копирования готового пакета.

Структура portable-хранилища была подтверждена на прежней версии 0.1.6; ниже указан пакет 0.2.2. Обновление этой portable-установки в текущую проверку не входило.

Это не официальный способ Adobe и не универсальный рецепт для всех portable-сборок. Если у вас другой лаунчер, другая структура папок или нет описанного `PS.json`, сначала выясните, где ваша сборка хранит UXP-плагины. Не создавайте системные папки наугад и не заменяйте чужую регистрацию.

Этот лаунчер при запуске подставляет собственную UXP-среду вместо обычной системной копии. Поэтому CCX, установленный через UPIA в обычный Photoshop, может не появиться в portable.

Постоянное хранилище этой сборки:

```text
C:\Photoshop\App\Program Files\Common Files\Adobe\UXP\Plugins\External
```

Регистрация:

```text
C:\Photoshop\App\Program Files\Common Files\Adobe\UXP\PluginsInfo\v1\PS.json
```

<a id="portable-install"></a>
## Установка готового CCX

1. Сохраните документы и полностью закройте Photoshop, portable-лаунчер и UXP Developer Tool. Не завершайте Photoshop принудительно с несохранённой работой.
2. Скачайте [готовый CCX 0.2.2](../ccx/com.local.photoshop.flux-local-edit_PS.ccx). Сделайте резервную копию существующего `PS.json`. При обновлении сохраните также только старую папку этого плагина. Не нужно копировать весь Photoshop.
3. Откройте CCX как ZIP-совместимый архив через 7-Zip. Если архиватор не открывает расширение, сделайте копию CCX с расширением `.zip`. Исходный CCX оставьте без изменений.
4. Создайте точную папку версии:

```text
C:\Photoshop\App\Program Files\Common Files\Adobe\UXP\Plugins\External\com.local.photoshop.flux-local-edit_0.2.2
```

5. Распакуйте **содержимое** CCX туда. `manifest.json`, `index.html`, `styles.css`, `src`, `icons` и `workflows` должны лежать непосредственно внутри папки версии. Дополнительной вложенной папки между ней и manifest быть не должно.
6. Откройте `PS.json` в текстовом редакторе. В существующий массив `plugins` добавьте следующий объект или обновите существующий объект с тем же `pluginId`:

```json
{
  "hostMinVersion": "25.0.0",
  "name": "Flux Local Edit",
  "path": "$systemPlugins\\External\\com.local.photoshop.flux-local-edit_0.2.2",
  "pluginId": "com.local.photoshop.flux-local-edit",
  "status": "enabled",
  "type": "uxp",
  "versionString": "0.2.2"
}
```

**Не заменяйте весь PS.json этим фрагментом.** Это только один элемент массива. Сохраните все другие поля и плагины, включая Flux2 Klein и SeedVR2. Следите за запятыми между объектами; после последнего объекта запятая не нужна. Не оставляйте две активные записи одного `pluginId`.

7. Проверьте JSON в PowerShell:

```powershell
$portableInfo = "C:\Photoshop\App\Program Files\Common Files\Adobe\UXP\PluginsInfo\v1\PS.json"
$portableConfig = Get-Content -LiteralPath $portableInfo -Raw | ConvertFrom-Json
$portableConfig.plugins | Format-Table name, pluginId, versionString, path
```

Если есть ошибка разбора, исправьте файл или восстановите его резервную копию до запуска Photoshop.

8. Запустите **именно** `C:\Photoshop\PhotoshopPortable.exe`, а не внутренний Photoshop.exe.
9. Откройте **Подключаемые модули → Flux Local Edit → Flux Local Edit** и выполните небольшой тест с запущенным ComfyUI.

Путь с кириллицей сам по себе не был причиной прежней невидимости плагина у автора. Причиной была подмена UXP-среды лаунчером. Копирование CCX в папку Plug-ins тоже не регистрирует UXP-панель.

<a id="portable-update"></a>
## Как обновлять

Для нового релиза берите ID, версию и minVersion из manifest внутри нового CCX. Создайте папку `<plugin-id>_<version>`, распакуйте туда новый пакет и обновите только соответствующую запись в `PS.json`: путь, имя, версия и hostMinVersion.

Все действия выполняйте при закрытом Photoshop. Перед изменением сохраните старую папку и регистрацию. Старую версию удаляйте только после успешной проверки новой и только по её точному пути внутри `Plugins\External`. Не удаляйте весь UXP, External или другие плагины. Этот документ сам ничего не устанавливает и не удаляет.

Если правится код без изменения версии, возможна замена файлов в папке той же версии при закрытом Photoshop. Для распространяемого релиза безопаснее повысить версию и собрать новый CCX через UDT.

<a id="portable-check"></a>
## Если панель не появилась

- Проверьте совпадение `pluginId` в PS.json и `id` в manifest.
- Проверьте, что `path` указывает на существующую папку и manifest лежит в её корне.
- Проверьте JSON и отсутствие дубликатов этого ID.
- Проверьте версию Photoshop: нужно 25.0+.
- Выгрузите dev-копию того же плагина в UDT и полностью перезапустите лаунчер.
- После запуска рабочая копия должна появиться в `C:\Program Files\Common Files\Adobe\UXP\Plugins\External\com.local.photoshop.flux-local-edit_0.2.2`. Постоянный источник при этом остаётся внутри `C:\Photoshop\App`.

Если файлы есть только в `C:\Program Files\Common Files\Adobe\UXP.BackupByPhotoshopPortable`, значит они попали в обычную системную среду, которую portable-лаунчер убрал в резервную копию. Нужны постоянные файлы и регистрация именно внутри `C:\Photoshop\App`.

Установка панели не заменяет настройку ComfyUI. После появления панели продолжите [основную инструкцию](INSTALLATION_RU.md#comfyui).
