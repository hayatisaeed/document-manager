-- Turn <span class="citation" data-cites="key1;key2"> (inserted by the
-- rich-text editor) into real pandoc citations so --citeproc formats them.
function Span(el)
  local cites = el.attributes['data-cites'] or el.attributes['cites']
  if el.classes:includes('citation') and cites then
    local citations = {}
    for key in cites:gmatch('[^%s;,]+') do
      table.insert(citations, pandoc.Citation(key, 'NormalCitation'))
    end
    return pandoc.Cite(el.content, citations)
  end
end
