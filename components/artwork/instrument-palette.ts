// The existing physical geometry uses a light rose metal finish in this edition.
const ramps = {
  lo: { fill: '#d6bfcc', top: '#e8d5de', line: '#98758a', shades: ['#aa889e', '#b795aa', '#c2a3b6', '#d0b6c5'] },
  mid: { fill: '#dec5d1', top: '#f1dfe5', line: '#9b7589', shades: ['#b18b9f', '#bd9aaf', '#ccadbc', '#dcc1cd'] },
  hi: { fill: '#e7cdd8', top: '#fff2f2', line: '#af8499', shades: ['#bf97aa', '#cda7b9', '#ddbdcb', '#ebd0db'] },
  paper: { fill: '#f2e5df', top: '#fffaf3', line: '#b593a2', shades: ['#c2a6b1', '#d4bcc3', '#e4d0d3', '#f1e1de'] },
  rose: { fill: '#c5789f', top: '#e9afc8', line: '#955373', shades: ['#a45b82', '#b76d93', '#ca86a8', '#dda0bb'] },
};

export const instrumentPalette = `
.mi-drawing .iso-line{fill:none;stroke:#98758a;stroke-width:.65;stroke-linecap:round;stroke-linejoin:round}
.mi-drawing .iso-crease{opacity:.35}.mi-drawing .iso-bevel{opacity:.35}
.mi-drawing .iso-line[data-tone="faint"]{opacity:.35}.mi-drawing .iso-line[data-tone="lo"]{opacity:.65}
.mi-drawing .iso-line[data-tone="hi"]{stroke:#fff8f3}
${Object.entries(ramps).map(([tone, ramp]) => `
.mi-drawing .iso-solid[data-tone="${tone}"]>.iso-fill{fill:${ramp.fill}}
.mi-drawing .iso-solid[data-tone="${tone}"]>.iso-top{fill:${ramp.top}}
${ramp.shades.map((shade, index) => `.mi-drawing .iso-solid[data-tone="${tone}"]>.iso-shade[data-shade="${index}"]{fill:${shade}}`).join('')}
.mi-drawing .iso-solid[data-tone="${tone}"]>.iso-edge{stroke:${ramp.line}}
`).join('')}`;
