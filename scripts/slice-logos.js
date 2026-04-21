const sharp = require('sharp');
const path = require('path');

const INPUT = '/Users/bheng/.claude/image-cache/12d17b2f-0ac1-4af9-ba5d-70ae95f2315d/3.png';
const OUT = path.join(__dirname, '..', 'public', 'favicons');

// Grid: 5 columns x 2 rows, with labels below each icon
// We'll detect positions from the image layout
async function main() {
  const img = sharp(INPUT);
  const meta = await img.metadata();
  console.log(`Image: ${meta.width}x${meta.height}`);

  const w = meta.width;
  const h = meta.height;

  // 5 cols x 2 rows grid with labels underneath
  // Top row: tools, diagrams, claude dashboard, stickies, mindmaps
  // Bottom row: safe, drop, ai-spinner, moments, frames
  // Icons appear to be evenly spaced, labels at bottom of each cell

  const cols = 5;
  const rows = 2;
  const cellW = Math.floor(w / cols);
  const cellH = Math.floor(h / rows);

  // Each cell has the icon centered in the upper portion, label at bottom
  // Icon is roughly square, about 60-70% of cell width
  const iconPad = Math.floor(cellW * 0.12); // padding from cell edges
  const topPad = Math.floor(cellH * 0.05);  // top padding
  const labelH = Math.floor(cellH * 0.22);  // label area at bottom

  const apps = [
    // Row 0
    ['tools', 0, 0],
    ['diagrams', 1, 0],
    ['claude', 2, 0],
    ['stickies', 3, 0],
    ['mindmaps', 4, 0],
    // Row 1
    ['safe', 0, 1],
    ['drop', 1, 1],
    ['ai-spinner', 2, 1],
    ['moments', 3, 1],
    ['frames', 4, 1],
  ];

  for (const [name, col, row] of apps) {
    const cellX = col * cellW;
    const cellY = row * cellH;

    // Extract just the icon area (exclude label)
    const iconAreaH = cellH - labelH;
    const iconSize = Math.min(cellW - iconPad * 2, iconAreaH - topPad * 2);

    const x = cellX + Math.floor((cellW - iconSize) / 2);
    const y = cellY + topPad + Math.floor((iconAreaH - iconSize) / 2);

    const extractW = Math.min(iconSize, w - x);
    const extractH = Math.min(iconSize, h - y);

    if (extractW <= 0 || extractH <= 0) {
      console.log(`SKIP ${name}: invalid dimensions`);
      continue;
    }

    const outPath = path.join(OUT, `${name}.png`);
    await sharp(INPUT)
      .extract({ left: x, top: y, width: extractW, height: extractH })
      .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(outPath);

    console.log(`OK ${name} -> ${outPath} (${x},${y} ${extractW}x${extractH})`);
  }

  console.log('\nDone! All icons saved to public/favicons/');
}

main().catch(console.error);
