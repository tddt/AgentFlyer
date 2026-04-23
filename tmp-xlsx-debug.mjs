import XLSX from './src/gateway/console-ui/node_modules/xlsx-js-style/dist/xlsx.bundle.js';
import { readFileSync } from 'fs';

const buf = readFileSync('d:/agentflyer_workspace/worker2_space/自媒体传播强度分析.xlsx');
const wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellStyles: true });
const sheet = wb.Sheets[wb.SheetNames[0]];
const range = XLSX.utils.decode_range(sheet['!ref']);
console.log('SheetName:', wb.SheetNames[0]);
console.log('Range:', sheet['!ref']);

// Print ALL cells, flag those where w is '' but v is not null/0
for (let R = range.s.r; R <= range.e.r; R++) {
  for (let C = range.s.c; C <= range.e.c; C++) {
    const addr = XLSX.utils.encode_cell({ r: R, c: C });
    const cell = sheet[addr];
    if (!cell) continue;
    const wStr = JSON.stringify(cell.w);
    const vStr = JSON.stringify(cell.v);
    // Flag: w is empty/undefined but v has meaningful data
    const suspicious = (cell.w === '' || cell.w === undefined) && cell.v !== undefined && cell.v !== null && cell.v !== 0 && cell.v !== '';
    if (suspicious || (typeof cell.w === 'string' && cell.w === '' && cell.v !== undefined)) {
      console.log(`SUSPECT [${addr}] t=${cell.t} v=${vStr} w=${wStr} f=${JSON.stringify(cell.f)}`);
    }
  }
}

// Also print header row + first 3 data rows in detail
console.log('\n--- Header + first 3 data rows ---');
for (let R = range.s.r; R <= Math.min(range.s.r + 3, range.e.r); R++) {
  const row = [];
  for (let C = range.s.c; C <= range.e.c; C++) {
    const addr = XLSX.utils.encode_cell({ r: R, c: C });
    const cell = sheet[addr];
    if (cell) {
      row.push(`[${addr}:t=${cell.t},v=${JSON.stringify(cell.v)},w=${JSON.stringify(cell.w)},f=${JSON.stringify(cell.f)}]`);
    } else {
      row.push(`[${addr}:empty]`);
    }
  }
  console.log('Row', R, ':\n ', row.join('\n  '));
}
