-- Normalise callouts from every source format into one shape:
--   Div(classes={"callout"}, attributes={type=<kind>, title=<plain text>})
--
-- Recognised input:
--   Markdown (GitHub / Obsidian):  > [!warning] Optional title
--                                  > Body...
--   Rich text (HTML):              <div class="callout" data-callout="tip" data-title="...">
--   LaTeX:                         \begin{callout}{note}{Optional title} ... \end{callout}
--
-- Also strips the "language-" prefix some editors put on code block classes.

local KINDS = {
  note = 'note', info = 'note', todo = 'note', abstract = 'note', summary = 'note',
  tip = 'tip', hint = 'tip', success = 'tip', check = 'tip', done = 'tip',
  important = 'important', question = 'important', help = 'important', faq = 'important',
  warning = 'warning', caution = 'warning', attention = 'warning',
  danger = 'danger', error = 'danger', bug = 'danger', failure = 'danger', fail = 'danger',
  example = 'example', quote = 'quote', cite = 'quote',
}

local function normalise_kind(kind)
  kind = (kind or 'note'):lower()
  return KINDS[kind] or 'note'
end

local function make(kind, title, blocks)
  return pandoc.Div(blocks, pandoc.Attr('', {'callout'}, {{'type', normalise_kind(kind)}, {'title', title or ''}}))
end

-- Split inlines at the first SoftBreak/LineBreak.
local function split_first_line(inlines)
  local first, rest, seen = pandoc.Inlines{}, pandoc.Inlines{}, false
  for _, el in ipairs(inlines) do
    if not seen and (el.t == 'SoftBreak' or el.t == 'LineBreak') then
      seen = true
    elseif seen then
      rest:insert(el)
    else
      first:insert(el)
    end
  end
  return first, rest
end

function BlockQuote(el)
  local para = el.content[1]
  if not para or (para.t ~= 'Para' and para.t ~= 'Plain') then return nil end
  local marker = para.content[1]
  if not marker or marker.t ~= 'Str' then return nil end
  local kind = marker.text:match('^%[!(%w+)%][-+]?$')
  if not kind then return nil end
  local first, rest = split_first_line(para.content)
  first:remove(1)
  if first[1] and first[1].t == 'Space' then first:remove(1) end
  local blocks = pandoc.Blocks{}
  if #rest > 0 then blocks:insert(pandoc.Para(rest)) end
  for i = 2, #el.content do blocks:insert(el.content[i]) end
  return make(kind, pandoc.utils.stringify(first), blocks)
end

function Div(el)
  if not el.classes:includes('callout') then return nil end
  local attrs = el.attributes
  local kind = attrs['type'] or attrs['callout'] or attrs['data-callout']
  local title = attrs['title'] or attrs['data-title']
  if kind then
    return make(kind, title, el.content)
  end
  -- LaTeX: \begin{callout}{kind}{title} arrives as a paragraph starting with two spans.
  local para = el.content[1]
  if para and para.t == 'Para' and para.content[1] and para.content[1].t == 'Span' then
    kind = pandoc.utils.stringify(para.content[1])
    local rest = pandoc.Inlines{}
    local i = 2
    if para.content[2] and para.content[2].t == 'Span' then
      title = pandoc.utils.stringify(para.content[2])
      i = 3
    end
    if para.content[i] and (para.content[i].t == 'SoftBreak' or para.content[i].t == 'Space') then i = i + 1 end
    for j = i, #para.content do rest:insert(para.content[j]) end
    local blocks = pandoc.Blocks{}
    if #rest > 0 then blocks:insert(pandoc.Para(rest)) end
    for j = 2, #el.content do blocks:insert(el.content[j]) end
    return make(kind, title, blocks)
  end
  return make('note', title, el.content)
end

function CodeBlock(el)
  local changed = false
  for i, cls in ipairs(el.classes) do
    local lang = cls:match('^language%-(.+)$') or cls:match('^lang%-(.+)$')
    if lang then el.classes[i] = lang; changed = true end
  end
  if changed then return el end
end
