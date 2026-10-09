-- Render normalised callouts (see callouts.lua) for the output format.
--   LaTeX/PDF : tcolorbox (environment defined in the generated header)
--   DOCX/ODT  : a one-cell table with a bold heading row
--   HTML/EPUB : <div class="callout callout-KIND"> styled by the export CSS

local LABELS = {
  en = { note = 'Note', tip = 'Tip', important = 'Important', warning = 'Warning',
         danger = 'Danger', example = 'Example', quote = 'Quote' },
  fa = { note = 'یادداشت', tip = 'نکته', important = 'مهم', warning = 'هشدار',
         danger = 'خطر', example = 'مثال', quote = 'نقل‌قول' },
}

local doc_lang = 'en'

local function label(kind, title)
  if title and title ~= '' then return title end
  return (LABELS[doc_lang] or LABELS.en)[kind] or kind
end

local function latex_escape(text)
  return pandoc.write(pandoc.Pandoc({pandoc.Plain({pandoc.Str(text)})}), 'latex'):gsub('%s+$', '')
end

function Meta(meta)
  if meta.lang then
    doc_lang = pandoc.utils.stringify(meta.lang):sub(1, 2)
  end
end

function Div(el)
  if not el.classes:includes('callout') then return nil end
  local kind = el.attributes['type'] or 'note'
  local heading = label(kind, el.attributes['title'])

  if FORMAT:match('latex') or FORMAT:match('beamer') then
    local blocks = pandoc.Blocks{pandoc.RawBlock('latex',
      '\\begin{dmcallout}{dmcallout' .. kind .. '}{' .. latex_escape(heading) .. '}')}
    blocks:extend(el.content)
    blocks:insert(pandoc.RawBlock('latex', '\\end{dmcallout}'))
    return blocks
  end

  if FORMAT:match('docx') or FORMAT:match('odt') or FORMAT:match('rtf') then
    local head = {pandoc.Plain({pandoc.Strong({pandoc.Str(heading)})})}
    local simple = pandoc.SimpleTable(
      {}, {pandoc.AlignDefault}, {0}, {head}, {el.content})
    return pandoc.utils.from_simple_table(simple)
  end

  if FORMAT:match('html') or FORMAT:match('epub') then
    local title = pandoc.Div({pandoc.Plain({pandoc.Str(heading)})}, pandoc.Attr('', {'callout-title'}))
    local body = pandoc.Div(el.content, pandoc.Attr('', {'callout-body'}))
    el.classes:insert('callout-' .. kind)
    el.attributes['type'] = nil
    el.attributes['title'] = nil
    el.content = {title, body}
    return el
  end

  -- Markdown and other text formats: a blockquote with the GitHub/Obsidian marker.
  local first = pandoc.Para({pandoc.Str('[!' .. kind .. ']'), pandoc.Space(), pandoc.Str(el.attributes['title'] or '')})
  local blocks = pandoc.Blocks{first}
  blocks:extend(el.content)
  return pandoc.BlockQuote(blocks)
end

return {{Meta = Meta}, {Div = Div}}
