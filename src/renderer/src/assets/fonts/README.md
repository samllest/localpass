UI glyph subsets reconstructed from the user-approved Ardot HTML export of Noto Sans SC. Original Unicode mapping restored for dynamic application text. Missing characters use the system font fallback. No private vault data is included.

Noto Sans SC is licensed under the SIL Open Font License 1.1; the upstream license is included as `OFL.txt` and shipped alongside the packaged fonts.

The export declares zero descent even though glyphs such as g/j/p and Chinese characters extend below the baseline. `input-font.css` provides the same Regular glyphs as `LocalPass Ardot Input`, with 116% ascent and 29% descent for native inputs, selects and textareas. This reserves their full glyph bounds during native control painting. Keep this control-specific face when regenerating the design subsets. Native password masks use system glyphs for normal bullet spacing.
