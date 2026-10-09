-- Bidirectional (RTL/LTR) support for mixed Persian/English documents.
--
-- Every block gets the direction of its first strong character, exactly like
-- HTML's dir="auto". Blocks whose direction differs from the document's main
-- direction are wrapped in a Div with dir=..., which pandoc turns into
-- \begin{otherlanguage}/RTL environments (LaTeX), bidi paragraphs (DOCX) or
-- dir attributes (HTML/EPUB). Inline runs in the other script are tagged with
-- lang/dir spans so fonts, hyphenation and Word's run properties are right.
-- Inline bidi reordering itself is left to the renderer (babel bidi=basic in
-- LuaLaTeX, the Unicode bidi algorithm in browsers and Word).

local RTL_LANG = 'fa'
local LTR_LANG = 'en'

local function cp_dir(c)
  if (c >= 0x0590 and c <= 0x08FF) or (c >= 0xFB1D and c <= 0xFDFF) or (c >= 0xFE70 and c <= 0xFEFC) then
    return 'rtl'
  end
  if (c >= 0x41 and c <= 0x5A) or (c >= 0x61 and c <= 0x7A) or (c >= 0xC0 and c <= 0x24F)
      or (c >= 0x370 and c <= 0x52F) then
    return 'ltr'
  end
  return nil
end

local function first_strong(text)
  for _, c in utf8.codes(text) do
    local d = cp_dir(c)
    if d then return d end
  end
  return nil
end

-- Script of a single Str: 'rtl', 'ltr', or nil when it has no letters.
local function str_dir(text)
  local rtl, ltr = false, false
  for _, c in utf8.codes(text) do
    local d = cp_dir(c)
    if d == 'rtl' then rtl = true elseif d == 'ltr' then ltr = true end
  end
  if rtl and not ltr then return 'rtl' end
  if ltr and not rtl then return 'ltr' end
  return nil
end

local main_dir = 'ltr'

-- Inline runs only carry a language: renderers derive direction from it (babel
-- bidi=basic, Word) or from the characters themselves (browsers). An explicit
-- dir on spans would make pandoc emit \\LR/\\RL, which babel+LuaLaTeX lacks.
local function span_attr(dir)
  if FORMAT:match('html') or FORMAT:match('epub') then
    return pandoc.Attr('', {}, {{'dir', dir}, {'lang', dir == 'rtl' and RTL_LANG or LTR_LANG}})
  end
  return pandoc.Attr('', {}, {{'lang', dir == 'rtl' and RTL_LANG or LTR_LANG}})
end

-- Wrap runs of opposite-script words (with the spaces between them) in spans.
local function tag_inlines(inlines, para_dir)
  local out = pandoc.Inlines{}
  local run, run_dir = nil, nil
  local pending = pandoc.Inlines{}  -- spaces/punctuation that may join a run

  local function flush()
    if run then
      out:insert(pandoc.Span(run, span_attr(run_dir)))
      run, run_dir = nil, nil
    end
    out:extend(pending)
    pending = pandoc.Inlines{}
  end

  for _, el in ipairs(inlines) do
    local d = nil
    if el.t == 'Str' then d = str_dir(el.text) end
    if el.t == 'Str' and d and d ~= para_dir then
      if run and run_dir == d then
        run:extend(pending)
        pending = pandoc.Inlines{}
        run:insert(el)
      else
        flush()
        run, run_dir = pandoc.Inlines{el}, d
      end
    elseif run and (el.t == 'Space' or (el.t == 'Str' and not d)) then
      pending:insert(el)
    else
      flush()
      out:insert(el)
    end
  end
  flush()
  return out
end

local function block_dir(block)
  return first_strong(pandoc.utils.stringify(block)) or main_dir
end

local function tag_block_inlines(block, dir)
  if block.content and (block.t == 'Para' or block.t == 'Plain' or block.t == 'Header') then
    block.content = tag_inlines(block.content, dir)
  end
  return block
end

local function process_blocks(blocks, parent_dir, in_list)
  local out = pandoc.Blocks{}
  for _, block in ipairs(blocks) do
    if block.t == 'Div' and block.attributes.dir then
      local d = block.attributes.dir
      block.content = process_blocks(block.content, d)
      out:insert(block)
    elseif block.t == 'CodeBlock' then
      -- Code is always left-to-right, even inside a Persian document.
      if parent_dir == 'rtl' then
        out:insert(pandoc.Div({block}, pandoc.Attr('', {}, {{'dir', 'ltr'}, {'lang', LTR_LANG}})))
      else
        out:insert(block)
      end
    elseif block.t == 'RawBlock' or block.t == 'HorizontalRule' then
      out:insert(block)
    else
      local d = block_dir(block)
      if block.t == 'Para' or block.t == 'Plain' or block.t == 'Header' then
        tag_block_inlines(block, d)
      elseif block.t == 'BulletList' or block.t == 'OrderedList' then
        block.content = block.content:map(function(item) return process_blocks(item, d, true) end)
      elseif block.t == 'BlockQuote' or block.t == 'Div' then
        block.content = process_blocks(block.content, d)
      end
      if d ~= parent_dir and in_list and (block.t == 'Para' or block.t == 'Plain') then
        -- Keep list items inside the list: tag the text instead of wrapping the block.
        block.content = pandoc.Inlines{pandoc.Span(block.content, span_attr(d))}
        out:insert(block)
      elseif d ~= parent_dir then
        out:insert(pandoc.Div({block}, pandoc.Attr('', {}, {{'dir', d}, {'lang', d == 'rtl' and RTL_LANG or LTR_LANG}})))
      else
        out:insert(block)
      end
    end
  end
  return out
end

function Pandoc(doc)
  local meta_dir = doc.meta.dir and pandoc.utils.stringify(doc.meta.dir)
  if meta_dir == 'rtl' or meta_dir == 'ltr' then
    main_dir = meta_dir
  end
  doc.blocks = process_blocks(doc.blocks, main_dir)
  return doc
end
