/**
 * HtmlEditor — TinyMCE-basierter WYSIWYG-Editor für HTML-Files im FilePreview.
 *
 * Adaptiert vom werkingflow-production TinyMCECore (apps/werking-report).
 * Vereinfacht für File-Editing: nur Document-Mode, kein Excalidraw, dark theme.
 */

import { useRef, useEffect } from 'react';
import { Editor as TinyMCEEditor } from '@tinymce/tinymce-react';
import type { Editor as TinyMCEEditorType } from 'tinymce';

interface HtmlEditorProps {
  content: string;
  onChange: (content: string) => void;
  /** Optional: Callback when editor is ready (z. B. um setContent von außen zu erlauben). */
  onReady?: (editor: TinyMCEEditorType) => void;
}

const PLUGINS = [
  'advlist', 'autolink', 'lists', 'link', 'image',
  'searchreplace', 'visualblocks', 'code', 'fullscreen',
  'table', 'wordcount', 'pagebreak',
];

const TOOLBAR = [
  'undo redo |',
  'blocks | bold italic underline strikethrough |',
  'alignleft aligncenter alignright |',
  'bullist numlist | table link image |',
  'pagebreak | searchreplace removeformat code',
].join(' ');

const DARK_THEME_CSS = `
  .tinymce-cui-dark .tox-tinymce {
    border: none !important;
    border-radius: 0 !important;
  }
  .tinymce-cui-dark .tox-editor-header {
    background: var(--tn-bg-dark, #1a1b26) !important;
    border-bottom: 1px solid var(--tn-border, #414868) !important;
    padding: 6px 12px !important;
  }
  .tinymce-cui-dark .tox-toolbar__primary {
    background: transparent !important;
  }
  .tinymce-cui-dark .tox-tbtn {
    color: var(--tn-text-muted, #a9b1d6) !important;
    border-radius: 4px !important;
  }
  .tinymce-cui-dark .tox-tbtn:hover {
    background: var(--tn-bg-highlight, #2a2c3e) !important;
    color: var(--tn-text, #c0caf5) !important;
  }
  .tinymce-cui-dark .tox-tbtn--enabled,
  .tinymce-cui-dark .tox-tbtn--enabled:hover {
    background: rgba(125, 207, 255, 0.2) !important;
    color: var(--tn-blue, #7dcfff) !important;
  }
  .tinymce-cui-dark .tox-tbtn svg { fill: currentColor !important; }
  .tinymce-cui-dark .tox-split-button__chevron svg { fill: currentColor !important; }
  .tinymce-cui-dark .tox-toolbar__group {
    border-color: var(--tn-border, #414868) !important;
    padding: 0 6px !important;
  }
  .tinymce-cui-dark .tox-promotion,
  .tinymce-cui-dark .tox-statusbar__branding { display: none !important; }
  .tinymce-cui-dark .tox-statusbar {
    background: var(--tn-bg-dark, #1a1b26) !important;
    border-top: 1px solid var(--tn-border, #414868) !important;
    color: var(--tn-text-muted, #a9b1d6) !important;
  }
  .tinymce-cui-dark .tox-statusbar__wordcount,
  .tinymce-cui-dark .tox-statusbar__path-item {
    color: var(--tn-text-muted, #a9b1d6) !important;
  }
  .tox .tox-menu {
    background: var(--tn-bg-dark, #1a1b26) !important;
    border: 1px solid var(--tn-border, #414868) !important;
  }
  .tox .tox-collection__item { color: var(--tn-text, #c0caf5) !important; }
  .tox .tox-collection__item--active {
    background: var(--tn-bg-highlight, #2a2c3e) !important;
  }
`;

/**
 * Wrapper um TinyMCE für HTML-Editing.
 *
 * Wichtig: TinyMCE läuft uncontrolled (`initialValue`), nicht `value`.
 * Externe Content-Updates müssen via Editor-Ref + setContent() erfolgen.
 */
export function HtmlEditor({ content, onChange, onReady }: HtmlEditorProps) {
  const editorRef = useRef<TinyMCEEditorType | null>(null);
  // Re-mount key: nur ändern wenn die Datei wechselt (content-prop ist initialValue!).
  // Wir nehmen die ersten 80 Zeichen als heuristischer Identifier.
  const remountKey = useRef<string>(content.slice(0, 80));
  if (content.slice(0, 80) !== remountKey.current && editorRef.current) {
    // Echte File-Änderung von außen → setContent über Ref
    try {
      editorRef.current.setContent(content);
      remountKey.current = content.slice(0, 80);
    } catch {
      // silent: setContent kann fehlschlagen wenn Editor noch nicht ready
    }
  }

  useEffect(() => {
    return () => {
      // Cleanup beim Unmount
      editorRef.current = null;
    };
  }, []);

  return (
    <div
      className="tinymce-cui-dark"
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <style>{DARK_THEME_CSS}</style>
      <TinyMCEEditor
        licenseKey="gpl"
        tinymceScriptSrc="/tinymce/tinymce.min.js"
        onInit={(_evt, editor) => {
          editorRef.current = editor as unknown as TinyMCEEditorType;
          if (onReady) onReady(editor as unknown as TinyMCEEditorType);
        }}
        initialValue={content}
        onEditorChange={(newContent) => onChange(newContent)}
        init={{
          height: '100%',
          menubar: false,
          base_url: '/tinymce',
          skin: 'oxide-dark',
          // Kein content_css: 'dark' → das würde body { color: #fff } setzen und
          // den Bericht-Style überschreiben. Wir lassen das Bericht-eigene <style>
          // im HTML wirken.
          content_css: undefined,
          plugins: PLUGINS,
          toolbar: TOOLBAR,
          toolbar_mode: 'sliding' as const,
          branding: false,
          promotion: false,
          statusbar: true,
          elementpath: false,
          resize: false,
          // HTML voll erhalten — keine "Cleanup"-Aktivität die Whitespace/Classes
          // aus dem Bericht-HTML wegwirft.
          valid_elements: '*[*]',
          extended_valid_elements: '*[*]',
          valid_children: '+body[style],+div[style]',
          verify_html: false,
          cleanup: false,
          convert_urls: false,
          relative_urls: false,
          remove_script_host: false,
          // Bei Bedarf: Removeformat-Verhalten begrenzen
          formats: {
            removeformat: [
              { selector: 'b,strong,em,i,u,strike', remove: 'all', split: true, expand: false, deep: true },
            ],
          },
        }}
      />
    </div>
  );
}
