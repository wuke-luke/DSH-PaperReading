// Paper Studio — browser half.
//
// Two registrations, nothing else:
//   sidebar.panellist  one icon in the global panel list
//   main (key)         the desk itself, an iframe onto /paper-studio/
//
// The heavy UI intentionally lives in its own document: it keeps React out of a
// dense, canvas-and-DOM reading surface, survives panel switches without
// remounting its state, and lets the host serve the same page to a plain browser
// for development.

window.__ModuleLoader__.load({
  id: 'dsh-paper-studio',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'paper-studio'
    const LABEL = 'DSH-PaperReading'

    /** The shell paints dark by flipping an attribute somewhere in the tree. */
    function currentTheme() {
      if (typeof document === 'undefined') return 'light'
      const root = document.documentElement
      if (!root) return 'light'
      if (root.hasAttribute('data-ds-dark-theme') || root.dataset?.theme === 'dark') return 'dark'
      if (document.body?.hasAttribute?.('data-ds-dark-theme')) return 'dark'
      if (document.querySelector?.('[data-ds-dark-theme]')) return 'dark'
      try {
        // Last resort: judge the painted background.
        const bg = getComputedStyle(document.body).backgroundColor
        const parts = bg.match(/\d+/g)
        if (parts && parts.length >= 3) {
          const [r, g, b] = parts.map(Number)
          if (0.2126 * r + 0.7152 * g + 0.0722 * b < 110) return 'dark'
        }
      } catch { /* no layout yet */ }
      return 'light'
    }

    /**
     * A chibi whale-girl reading: round head with a whale fluke on top, two
     * dot eyes, and an open book held right under the chin. Line art only —
     * it survives both 16px in the sidebar and a dark shell.
     */
    /**
     * The DeepSeek whale as line art, curled over an open book.
     *
     * The brand mark is a filled silhouette with internal cutouts, so it is
     * stroked through a traced outline (see dev/trace-whale.mjs) instead of
     * drawing the raw path: that keeps the logo's exact contour and drops the
     * noise a naive stroke would add. Coordinates are a 0..100 box.
     */
    const WHALE_OUTLINE = "M69.35 0.00 L70.21 0.12 L70.70 0.61 L71.79 4.03 L73.26 5.86 L74.73 6.84 L77.41 7.94 L80.10 10.26 L81.20 12.45 L81.44 13.92 L83.03 12.45 L85.71 10.99 L88.28 10.38 L91.70 10.38 L93.16 10.01 L95.24 8.79 L98.05 6.11 L99.27 6.35 L100.00 7.57 L99.76 10.87 L98.66 15.02 L97.56 17.34 L95.73 19.90 L93.16 22.22 L90.23 23.93 L86.94 25.03 L84.25 25.40 L83.88 25.76 L83.76 28.69 L83.03 33.33 L81.81 37.97 L79.85 43.22 L77.90 47.25 L75.09 52.01 L71.67 56.78 L69.72 58.97 L70.57 59.83 L73.14 60.56 L78.63 63.00 L79.24 63.98 L78.88 65.81 L78.14 66.54 L76.92 67.03 L72.41 67.64 L65.81 67.16 L62.15 65.93 L58.12 68.99 L52.38 71.79 L45.42 73.38 L37.24 73.75 L30.77 72.89 L24.54 70.94 L18.56 67.77 L12.82 63.37 L8.42 58.73 L4.76 53.36 L2.81 49.33 L1.59 45.91 L0.00 37.97 L0.00 30.65 L1.10 25.03 L3.42 19.41 L7.33 13.68 L10.74 10.38 L13.92 8.18 L16.61 6.84 L20.15 5.62 L26.50 4.64 L31.87 4.64 L36.87 5.25 L46.03 2.20 L49.08 1.83 L51.65 1.95 L52.99 2.44 L53.48 3.17 L51.04 4.88 L49.82 6.72 L49.69 8.79 L50.79 10.87 L56.90 15.38 L65.08 23.69 L67.64 25.89 L71.55 28.21 L73.26 28.57 L73.75 27.84 L74.85 23.69 L74.24 22.95 L72.53 21.86 L70.21 19.54 L68.99 17.83 L67.64 15.14 L66.67 11.11 L66.54 7.20 L66.91 4.76 L68.50 0.73ZM54.21 29.30 L52.87 29.67 L51.89 30.65 L51.77 31.62 L52.87 32.48 L55.56 32.84 L57.14 34.19 L57.39 34.92 L57.14 38.58 L57.88 40.54 L59.58 42.12 L61.42 42.98 L63.86 42.98 L65.93 42.12 L66.42 41.51 L66.06 39.56 L65.08 37.73 L61.90 33.33 L58.36 30.28 L56.29 29.43Z"
    const BOOK_PATH = 'M4.9 15.55c2.55-1 4.85-.9 6.45.5 1.6-1.4 3.9-1.5 6.45-.5v4.25c-2.55-1-4.85-.9-6.45.5-1.6-1.4-3.9-1.5-6.45-.5z'
    const BOOK_SPINE = 'M11.35 16v4.3'

    function WhaleReaderIcon({ size = 16, active = false }) {
      // At 16–18px the book turns into noise, so the sidebar gets the whale
      // alone; the larger brand mark and the empty state carry the book.
      const compact = size <= 18
      const scale = compact ? '0.215' : '0.209'
      const origin = compact ? '1.2 3.1' : '1.45 1.55'
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 1.2 : 1.1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('g', { transform: `translate(${origin}) scale(${scale})` },
          h('path', { d: WHALE_OUTLINE, strokeWidth: active ? 5.9 : 5.4 })),
        compact ? null : h('path', { d: BOOK_PATH }),
        compact ? null : h('path', { d: BOOK_SPINE, strokeWidth: 0.9 }),
      )
    }

    /**
     * The host mounts panel entries inside a flex column whose height is not
     * guaranteed to be definite; a 100%-height iframe would then collapse to
     * zero. Measure, fall back to the viewport, and keep listening.
     */
    function DeskPanel() {
      const boxRef = React.useRef(null)
      const frameRef = React.useRef(null)
      const [fallback, setFallback] = React.useState(0)
      const initialTheme = React.useRef(currentTheme()).current
      const [theme, setTheme] = React.useState(initialTheme)

      React.useEffect(() => {
        // Trust the shell's flex layout (`height: 100%`). Only when the panel
        // container is collapsed do we fall back to the viewport height — a
        // measured pixel height here would stretch the container itself.
        const measure = () => {
          const box = boxRef.current
          if (!box) return
          const parent = box.parentElement
          const parentHeight = parent?.getBoundingClientRect().height || 0
          if (parentHeight < 200) setFallback(Math.max(420, (typeof window === 'undefined' ? 800 : window.innerHeight) - 56))
        }
        measure()
        const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(measure) : null
        if (typeof window !== 'undefined') window.addEventListener('resize', measure)
        return () => {
          if (raf !== null) cancelAnimationFrame(raf)
          if (typeof window !== 'undefined') window.removeEventListener('resize', measure)
        }
      }, [])

      React.useEffect(() => {
        const frame = frameRef.current
        if (!frame) return
        const retry = () => setTimeout(() => { if (frame) frame.src = '/paper-studio/?t=' + Date.now() }, 800)
        frame.addEventListener('error', retry)
        return () => frame.removeEventListener('error', retry)
      }, [])

      React.useEffect(() => {
        // Follow the shell's theme without remounting the iframe: the document
        // keeps its own state, so a src change would reset the reader.
        const observer = typeof MutationObserver === 'function'
          ? new MutationObserver(() => setTheme(currentTheme()))
          : null
        observer?.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-ds-dark-theme', 'data-theme', 'class'],
          subtree: true,
        })
        return () => observer?.disconnect()
      }, [])

      React.useEffect(() => {
        frameRef.current?.contentWindow?.postMessage({ type: 'ps:theme', theme }, '*')
      }, [theme])

      return h(
        'div',
        {
          ref: boxRef,
          style: {
            width: '100%',
            height: fallback ? `${fallback}px` : '100%',
            minHeight: 0,
            background: theme === 'dark' ? '#141518' : '#f7f4ee',
            overflow: 'hidden',
          },
        },
        h('iframe', {
          ref: frameRef,
          src: `/paper-studio/?theme=${initialTheme}`,
          title: LABEL,
          onLoad: () => frameRef.current?.contentWindow?.postMessage({ type: 'ps:theme', theme }, '*'),
          style: { width: '100%', height: '100%', border: '0', display: 'block', background: theme === 'dark' ? '#141518' : '#f7f4ee' },
          allow: 'clipboard-write',
        }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 12,
            label: LABEL,
          }, WhaleReaderIcon))

          ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
          }, DeskPanel))
        } catch (error) {
          console.error('[paper-studio] client apply failed:', error)
        }
      },
    }
  },
})
