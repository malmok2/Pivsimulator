#!/usr/bin/env node
/* Bundles the app into two single-file outputs:
 *   dist/piv-simulator.html — a complete page, drop it on a web server or
 *                             open it straight from disk / embed in an iframe
 *   dist/artifact.html      — the same page as a fragment (no html/head/body),
 *                             for hosts that supply their own document shell
 * Run: node tools/build.js
 */
var fs = require('fs'), path = require('path');
var root = path.join(__dirname, '..');
var src = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }

var title = (src.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || 'PIV Simulator';
var desc = (src.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
var fontLink = (src.match(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis[^>]*>/) || [])[0] || '';
var cssFiles = [];
src.replace(/<link rel="stylesheet" href="((?:css|js)\/[^"]+)"[^>]*>/g, function (m, f) { cssFiles.push(f); return m; });
var jsFiles = [];
src.replace(/<script src="([^"]+)"><\/script>/g, function (m, f) { jsFiles.push(f); return m; });

var css = cssFiles.map(read).join('\n');
var js = jsFiles.map(function (f) {
  return '/* ===== ' + f + ' ===== */\n' + read(f);
}).join('\n');

var body = src.split(/<body[^>]*>/)[1].split('</body>')[0];
body = body.replace(/<script src="[^"]+"><\/script>\s*/g, '');

var head = [
  '<title>' + title + '</title>',
  desc ? '<meta name="description" content="' + desc + '">' : '',
  fontLink,
  '<style>\n' + css + '\n</style>'
].filter(Boolean).join('\n');

var fragment = head + '\n' + body.trim() + '\n<script>\n' + js + '\n</script>\n';

var full = '<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
  head + '\n<style>html,body{margin:0}</style>\n</head>\n<body>\n' +
  body.trim() + '\n<script>\n' + js + '\n</script>\n</body>\n</html>\n';

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/piv-simulator.html'), full);
fs.writeFileSync(path.join(root, 'dist/artifact.html'), fragment);
console.log('dist/piv-simulator.html  ' + (full.length / 1024).toFixed(1) + ' kB');
console.log('dist/artifact.html       ' + (fragment.length / 1024).toFixed(1) + ' kB');
