/* Transcode the reviewed website hero recordings for GitHub's README image surface.
 * Source clips remain in the marketing repository; no product states are synthesized.
 * node apps/web/scripts/generate-readme-tour.cjs --reviewed-captures --source-dir ../ApertureChat-Website
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const args = process.argv.slice(2);
const sourceIndex = args.indexOf('--source-dir');
if (!args.includes('--reviewed-captures') || sourceIndex < 0 || !args[sourceIndex + 1]) {
  throw new Error('Review the website clips, then pass --reviewed-captures --source-dir <website-checkout>.');
}
const source = path.resolve(args[sourceIndex + 1]);
const scenes = ['chat', 'followup', 'draft', 'slides', 'team', 'platform'];
const files = scenes.map(scene => path.join(source, 'assets/hero', `${scene}-v6-light.mp4`));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inputs = files.map((file, i) => ({ scene: scenes[i], file: path.basename(file), sha256: hash(file) }));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aperture-readme-tour-'));
const output = path.join(repo, 'docs/images');
try {
  // Normalize the frame rate and dimensions before concatenating complete chapters.
  // A modest palette and ordered dithering keep the full walkthrough lightweight.
  files.forEach((file, i) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file,
    '-an', '-vf', 'fps=10,scale=960:-2:flags=lanczos,setsar=1', '-c:v', 'ffv1',
    path.join(temporary, `${i}.mkv`)], { stdio: 'inherit' }));
  fs.writeFileSync(path.join(temporary, 'clips.txt'), scenes.map((_, i) => `file '${i}.mkv'`).join('\n'));
  const gif = path.join(temporary, 'product-walkthrough-light.gif');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0',
    '-i', path.join(temporary, 'clips.txt'), '-filter_complex',
    '[0:v]split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle',
    '-loop', '0', gif], { stdio: 'inherit' });
  const poster = path.join(temporary, 'product-walkthrough-light.png');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', files[0], '-frames:v', '1',
    '-vf', 'scale=960:-2:flags=lanczos', poster], { stdio: 'inherit' });
  fs.copyFileSync(gif, path.join(output, path.basename(gif)));
  fs.copyFileSync(poster, path.join(output, path.basename(poster)));
  const manifest = { sourceRepository: 'https://github.com/Aperture-Chat/ApertureChat-Website',
    theme: 'light', fps: 10, width: 960, chapters: inputs,
    output: { file: path.basename(gif), sha256: hash(gif), bytes: fs.statSync(gif).size } };
  fs.writeFileSync(path.join(output, 'product-walkthrough-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Built six complete light-mode chapters: ${manifest.output.bytes} bytes.`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
