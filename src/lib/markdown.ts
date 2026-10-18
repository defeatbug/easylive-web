/**
 * 极简 Markdown 渲染（AI 纪要专用）。
 *
 * 为什么不引入 marked/react-markdown：纪要的 prompt 已把输出约束在很小的子集
 * （标题 / 列表 / 任务列表 / 加粗 / 行内代码 / 引用），60 行手写渲染足够，
 * 还能**默认转义全部 HTML**——纪要内容来自 LLM，必须按不可信输入处理，防 XSS。
 */

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 行内：加粗、行内代码（先转义再套标签） */
function inline(s: string): string {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+?)`/g, '<code>$1</code>')
}

export function renderMarkdown(md: string): string {
  const lines = md.split('\n')
  let html = ''
  let listTag: '' | 'ul' | 'ol' = ''

  const closeList = () => {
    if (listTag) {
      html += `</${listTag}>`
      listTag = ''
    }
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (/^\s*$/.test(line)) {
      closeList()
      continue
    }
    let m: RegExpMatchArray | null
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      closeList()
      const level = m[1].length
      html += `<h${level}>${inline(m[2])}</h${level}>`
    } else if (/^---+$/.test(line.trim())) {
      closeList()
      html += '<hr/>'
    } else if ((m = line.match(/^\s*>\s?(.*)$/))) {
      closeList()
      html += `<blockquote>${inline(m[1])}</blockquote>`
    } else if ((m = line.match(/^\s*-\s*\[([ xX])\]\s+(.*)$/))) {
      if (listTag !== 'ul') {
        closeList()
        html += '<ul>'
        listTag = 'ul'
      }
      const checked = m[1].toLowerCase() === 'x' ? ' checked' : ''
      html += `<li class="md-task"><input type="checkbox" disabled${checked}/> ${inline(m[2])}</li>`
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (listTag !== 'ul') {
        closeList()
        html += '<ul>'
        listTag = 'ul'
      }
      html += `<li>${inline(m[1])}</li>`
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (listTag !== 'ol') {
        closeList()
        html += '<ol>'
        listTag = 'ol'
      }
      html += `<li>${inline(m[1])}</li>`
    } else {
      closeList()
      html += `<p>${inline(line)}</p>`
    }
  }
  closeList()
  return html
}
