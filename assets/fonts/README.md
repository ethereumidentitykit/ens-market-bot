# Bundled fallback fonts

These fonts let tweet images render names without relying on system fonts or
remote font downloads. Only the script fonts required by displayed names are
embedded in each image document. Every bundled font uses the SIL Open Font
License 1.1; its license is included alongside the asset.

[font-provenance.json](font-provenance.json) records every font's upstream URL,
version, original and packaged SHA-256 hashes, license hash, size, character
coverage and retained tables.

## Multilingual fonts

The following assets come from the official
[Google Fonts repository at revision c30b221beb0c1da59d563feb91ec8656a1fa972a](https://github.com/google/fonts/tree/c30b221beb0c1da59d563feb91ec8656a1fa972a).
Each has a corresponding `FamilyName-OFL.txt` license. Together these 21 files
add 1,217,444 bytes (about 1.16 MiB).

| Font file | Primary script coverage |
| --- | --- |
| `NotoSans-Regular.woff2` | Latin, Greek, Cyrillic |
| `NotoSansArabic-Regular.woff2` | Arabic |
| `NotoSansArmenian-Regular.woff2` | Armenian |
| `NotoSansBengali-Regular.woff2` | Bengali |
| `NotoSansDevanagari-Regular.woff2` | Devanagari, including Hindi |
| `NotoSansEthiopic-Regular.woff2` | Ethiopic |
| `NotoSansGeorgian-Regular.woff2` | Georgian |
| `NotoSansGujarati-Regular.woff2` | Gujarati |
| `NotoSansGurmukhi-Regular.woff2` | Gurmukhi |
| `NotoSansHebrew-Regular.woff2` | Hebrew |
| `NotoSansKannada-Regular.woff2` | Kannada |
| `NotoSansKhmer-Regular.woff2` | Khmer |
| `NotoSansLao-Regular.woff2` | Lao |
| `NotoSansMalayalam-Regular.woff2` | Malayalam |
| `NotoSansMyanmar-Regular.woff2` | Myanmar |
| `NotoSansOriya-Regular.woff2` | Odia (Unicode script name: Oriya) |
| `NotoSansSinhala-Regular.woff2` | Sinhala |
| `NotoSansTamil-Regular.woff2` | Tamil |
| `NotoSansTelugu-Regular.woff2` | Telugu |
| `NotoSansThai-Regular.woff2` | Thai |
| `NotoSerifTibetan-Regular.woff2` | Tibetan |

The variable TTF sources were instantiated at weight 400 and default values for
other axes, then compressed to WOFF2 with fontTools 4.68.0 and Brotli 1.2.1.
No glyph subsetting was performed. Each output retains its source's character
mappings and glyph order, including the GSUB/GPOS shaping tables required for
connected letters, ligatures and combining marks.

To reproduce an asset using the source recorded in the manifest:

```python
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

font = TTFont("source.ttf")
axes = {
    axis.axisTag: 400 if axis.axisTag == "wght" else axis.defaultValue
    for axis in font["fvar"].axes
}
instantiateVariableFont(font, axes, inplace=True)
font.flavor = "woff2"
font.save("FamilyName-Regular.woff2")
```

## CJK font

`NotoSansCJKsc-Regular.woff2` is Noto Sans CJK SC Regular, version 2.004,
copyright © 2014–2021 Adobe. It is distributed under the
[SIL Open Font License 1.1](OFL.txt).

Source: [notofonts/noto-cjk, Sans2.004 release](https://github.com/notofonts/noto-cjk/tree/Sans2.004).
The [original OTF](https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf)
was converted to WOFF2 with fontTools 4.68.0 and Brotli 1.2.1:

```sh
fonttools ttLib.woff2 compress NotoSansCJKsc-Regular.otf -o NotoSansCJKsc-Regular.woff2
```

No glyphs, character mappings, or layout features were removed. The conversion
retains 44,810 Unicode character mappings and 65,535 glyphs. WOFF2 packaging
removes the original format's digital-signature table and updates the header;
all other font tables match the upstream bytes.

The full font includes Simplified and Traditional Chinese, Japanese, Korean,
and some supplementary Han characters. It does not cover every Unicode Han
extension. Simplified Chinese glyph forms are the default.

SHA-256:

- Source OTF: `2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b`
- Bundled WOFF2: `689db17ebf1a1dc29b075c42d27a3101f4f91e888ded96dfe54af3d5df9faefa`

The renderer embeds this font locally when a name needs CJK glyphs, so rendering
does not depend on installed system fonts or an external font download.
