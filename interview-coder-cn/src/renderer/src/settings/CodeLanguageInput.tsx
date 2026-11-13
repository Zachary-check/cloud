import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  CODE_LANGUAGE_PRESETS,
  MAX_CODE_LANGUAGE_CHARS,
  normalizeCodeLanguage
} from '../../../shared/code-language'

interface CodeLanguageInputProps {
  /** The language stored in settings; '' means no constraint. */
  value: string
  onChange: (language: string) => void
}

/**
 * One-click presets plus a free-text field for the preferred code language.
 *
 * The text is held locally and committed on blur or Enter, like the other text
 * fields here: normalizing on every keystroke would rewrite the field under the
 * cursor, so a half-typed "C+" would lose its "+" before the second one lands.
 */
export function CodeLanguageInput({ value, onChange }: CodeLanguageInputProps) {
  const [text, setText] = useState(value)

  // Follow changes coming from outside the field (initial sync from the main
  // process, or a preset click) without discarding what is currently typed:
  // if the text already means the stored value, leave it exactly as typed.
  useEffect(() => {
    setText((current) =>
      normalizeCodeLanguage(current) === normalizeCodeLanguage(value) ? current : value
    )
  }, [value])

  const commit = () => {
    const normalized = normalizeCodeLanguage(text)
    // Echo the cleaned-up result back, so a paste with a stray newline visibly
    // snaps to the name that will actually be used.
    setText(normalized)
    if (normalized !== normalizeCodeLanguage(value)) onChange(normalized)
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {CODE_LANGUAGE_PRESETS.map((language) => {
          const active = normalizeCodeLanguage(value) === language
          return (
            <button
              key={language}
              type="button"
              onClick={() => {
                setText(language)
                onChange(language)
              }}
              className={cn(
                'rounded-full border px-3 py-1 text-xs transition-colors',
                active
                  ? 'border-blue-600 bg-blue-600 text-white'
                  : 'border-gray-300 bg-white hover:border-blue-400'
              )}
            >
              {language}
            </button>
          )
        })}
      </div>
      <Input
        value={text}
        maxLength={MAX_CODE_LANGUAGE_CHARS}
        placeholder="留空表示不限制；也可直接输入其它语言，例如 Kotlin"
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit()
            event.currentTarget.blur()
          }
        }}
        className="bg-white text-sm"
      />
    </div>
  )
}
