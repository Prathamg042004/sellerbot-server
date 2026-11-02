'use strict';
const fs=require('node:fs');
fs.rmSync('dashboard-dist',{recursive:true,force:true});
fs.mkdirSync('dashboard-dist/app',{recursive:true});
fs.copyFileSync('public/index.html','dashboard-dist/index.html');
fs.copyFileSync('public/index.html','dashboard-dist/app/index.html');
for(const file of ['workspace.js','workspace.css'])fs.copyFileSync('public/'+file,'dashboard-dist/app/'+file);
