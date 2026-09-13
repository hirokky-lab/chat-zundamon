"""Export an icon from the distributed PSD using only its original layers.
Run: uv run --with psd-tools python scripts/prepare-app-icon-master.py <source.psd>
No generative image processing; the source PSD is opened read-only.
"""
import hashlib
import json
import sys
from pathlib import Path
from PIL import Image
from psd_tools import PSDImage

source = Path(sys.argv[1])
source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
psd = PSDImage.open(source)
# Use the author's supplied mouth/eyebrow variants. Keep the original eyes/hair.
choices = {'!口': '*むふ', '!眉': '*普通眉'}
for layer in psd:
    if layer.name in choices:
        for child in layer:
            child.visible = child.name == choices[layer.name]
    if layer.name in ['尻尾的なアレ', '記号など']:
        layer.visible = False
# Square face-focused crop, retaining the small original collar below the chin.
crop = (195, 45, 875, 725)
portrait = psd.composite().crop(crop).convert('RGBA')
background = Image.new('RGBA', portrait.size, '#FFF9EC')
background.alpha_composite(portrait)
output = Path(__file__).resolve().parents[1] / 'apps/web/public/icons'
output.mkdir(parents=True, exist_ok=True)
background.convert('RGB').resize((1024,1024), Image.Resampling.LANCZOS).save(output/'zundamon-master-v2.png')
assert hashlib.sha256(source.read_bytes()).hexdigest() == source_hash
(output/'zundamon-master-v2.provenance.json').write_text(json.dumps({
    'source': source.name, 'sourceSha256': source_hash,
    'method': 'original PSD layer selection, crop, ivory background, resize',
    'selectedLayers': choices, 'hiddenLayers': ['尻尾的なアレ', '記号など'],
    'crop': crop, 'background': '#FFF9EC', 'generativeAI': False,
}, ensure_ascii=False, indent=2)+'\n')
