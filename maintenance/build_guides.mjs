import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {marked} = await import(process.argv[2] ? pathToFileURL(path.join(process.argv[2], 'marked/lib/marked.esm.js')).href : 'marked');
const guides = [
  ['INSTALLATION_RU.md', 'installation.html', [['requirements','Требования'],['photoshop','Панель Photoshop'],['comfyui','ComfyUI'],['models','Модели'],['workflow','Шаблоны'],['first-run','Первый запуск'],['multi-region','Несколько областей'],['actions','Горячие клавиши'],['troubleshooting','Ошибки'],['licenses','Лицензии']]],
  ['PORTABLE_RU.md', 'portable.html', [['portable-scope','Область применения'],['portable-install','Установка'],['portable-update','Обновление'],['portable-check','Проверка']]],
];
for (const [source, destination, toc] of guides) {
  let body = marked.parse(fs.readFileSync(path.join(root,'docs',source),'utf8'));
  body = body.replaceAll('href="PORTABLE_RU.md"', 'href="portable.html"').replaceAll('href="INSTALLATION_RU.md', 'href="installation.html');
  body = body.replaceAll('<table>', '<div class="table-scroll" tabindex="0" role="region" aria-label="Таблица, доступна горизонтальная прокрутка"><table>').replaceAll('</table>', '</table></div>');
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${source.startsWith('PORTABLE')?'Portable Photoshop':'Установка с нуля'} | Flux Local Edit</title><link rel="stylesheet" href="assets/site.css"><script src="assets/site.js" defer></script></head><body><a class="skip" href="#guide-main">Перейти к инструкции</a><header class="site-header wrap guide-header"><a class="brand" href="index.html"><span class="brand-mark" aria-hidden="true">F</span>Flux Local Edit</a><nav aria-label="Навигация"><a href="index.html">Презентация</a><a href="installation.html">Установка</a><a href="portable.html">Portable</a></nav></header><main class="guide-layout wrap"><aside class="guide-toc"><strong>В этой инструкции</strong><nav aria-label="Содержание">${toc.map(([id,title])=>`<a href="#${id}">${title}</a>`).join('')}</nav><button class="button print-button" data-print>Печать / PDF</button></aside><article id="guide-main" class="guide-content">${body}</article></main><footer class="wrap"><p>Flux Local Edit 0.2.2. Инструкция обновлена 5 ноября 2026 года.</p><a href="index.html">Вернуться к презентации</a></footer></body></html>`;
  fs.writeFileSync(path.join(root,'docs',destination),html);
  console.log(`Built ${destination}`);
}
