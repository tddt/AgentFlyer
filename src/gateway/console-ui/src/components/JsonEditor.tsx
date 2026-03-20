import { useState } from 'react'
import { Button } from './Button.js'

type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

type JsonType = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object'

interface JsonEditorProps {
  value: JsonValue
  onChange: (value: JsonValue) => void
  path?: string
  depth?: number
}

function detectType(value: JsonValue): JsonType {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  return 'string'
}

function createDefaultValue(type: JsonType): JsonValue {
  switch (type) {
    case 'string':
      return ''
    case 'number':
      return 0
    case 'boolean':
      return false
    case 'null':
      return null
    case 'array':
      return []
    case 'object':
      return {}
  }
}

function nextObjectKey(obj: Record<string, JsonValue>): string {
  const base = 'newKey'
  if (!(base in obj)) return base
  let i = 1
  while (`${base}${i}` in obj) i += 1
  return `${base}${i}`
}

function renameKey(obj: Record<string, JsonValue>, oldKey: string, newKey: string): Record<string, JsonValue> {
  if (oldKey === newKey || !newKey.trim()) return obj
  const key = newKey.trim()
  const entries = Object.entries(obj).map(([k, v]) => [k === oldKey ? key : k, v] as const)
  return Object.fromEntries(entries)
}

function FieldLabel({ path, depth }: { path: string; depth: number }) {
  return (
    <div className="text-[11px] uppercase tracking-wide text-slate-500" style={{ paddingLeft: `${depth * 8}px` }}>
      {path || 'root'}
    </div>
  )
}

export function JsonEditor({ value, onChange, path = 'root', depth = 0 }: JsonEditorProps) {
  const currentType = detectType(value)

  const handleTypeChange = (nextType: JsonType) => {
    if (nextType === currentType) return
    onChange(createDefaultValue(nextType))
  }

  if (currentType === 'object') {
    const obj = value as Record<string, JsonValue>
    const entries = Object.entries(obj)
    return (
      <div className="rounded-xl bg-slate-900/50 ring-1 ring-slate-700/60 p-3 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <FieldLabel path={path} depth={depth} />
          <div className="flex items-center gap-2">
            <select
              value={currentType}
              onChange={(e) => handleTypeChange(e.target.value as JsonType)}
              className="bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded-md px-2 py-1"
            >
              <option value="object">object</option>
              <option value="array">array</option>
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="boolean">boolean</option>
              <option value="null">null</option>
            </select>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const key = nextObjectKey(obj)
                onChange({ ...obj, [key]: '' })
              }}
            >
              + Field
            </Button>
          </div>
        </div>

        {entries.length === 0 && (
          <div className="text-xs text-slate-500">Empty object</div>
        )}

        {entries.map(([k, v]) => (
          <div key={`${path}.${k}`} className="grid grid-cols-[180px_minmax(0,1fr)_auto] gap-2 items-start">
            <input
              value={k}
              onChange={(e) => onChange(renameKey(obj, k, e.target.value))}
              className="bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded-md px-2 py-1.5"
            />
            <JsonEditor
              value={v}
              onChange={(next) => onChange({ ...obj, [k]: next })}
              path={`${path}.${k}`}
              depth={depth + 1}
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const next = { ...obj }
                delete next[k]
                onChange(next)
              }}
            >
              Remove
            </Button>
          </div>
        ))}
      </div>
    )
  }

  if (currentType === 'array') {
    const arr = value as JsonValue[]
    return (
      <div className="rounded-xl bg-slate-900/50 ring-1 ring-slate-700/60 p-3 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <FieldLabel path={path} depth={depth} />
          <div className="flex items-center gap-2">
            <select
              value={currentType}
              onChange={(e) => handleTypeChange(e.target.value as JsonType)}
              className="bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded-md px-2 py-1"
            >
              <option value="array">array</option>
              <option value="object">object</option>
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="boolean">boolean</option>
              <option value="null">null</option>
            </select>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onChange([...arr, ''])}
            >
              + Item
            </Button>
          </div>
        </div>

        {arr.length === 0 && (
          <div className="text-xs text-slate-500">Empty array</div>
        )}

        {arr.map((item, idx) => (
          <div key={`${path}[${idx}]`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 items-start">
            <JsonEditor
              value={item}
              onChange={(next) => {
                const clone = [...arr]
                clone[idx] = next
                onChange(clone)
              }}
              path={`${path}[${idx}]`}
              depth={depth + 1}
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const clone = [...arr]
                clone.splice(idx, 1)
                onChange(clone)
              }}
            >
              Remove
            </Button>
          </div>
        ))}
      </div>
    )
  }

  if (currentType === 'boolean') {
    return (
      <div className="rounded-lg bg-slate-900/40 ring-1 ring-slate-700/50 p-3 flex items-center justify-between gap-3">
        <FieldLabel path={path} depth={depth} />
        <div className="flex items-center gap-2">
          <select
            value={currentType}
            onChange={(e) => handleTypeChange(e.target.value as JsonType)}
            className="bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded-md px-2 py-1"
          >
            <option value="boolean">boolean</option>
            <option value="string">string</option>
            <option value="number">number</option>
            <option value="null">null</option>
            <option value="array">array</option>
            <option value="object">object</option>
          </select>
          <label className="inline-flex items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={value as boolean}
              onChange={(e) => onChange(e.target.checked)}
              className="accent-indigo-500"
            />
            {(value as boolean) ? 'true' : 'false'}
          </label>
        </div>
      </div>
    )
  }

  if (currentType === 'number') {
    return (
      <div className="rounded-lg bg-slate-900/40 ring-1 ring-slate-700/50 p-3 flex items-center justify-between gap-3">
        <FieldLabel path={path} depth={depth} />
        <div className="flex items-center gap-2">
          <select
            value={currentType}
            onChange={(e) => handleTypeChange(e.target.value as JsonType)}
            className="bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded-md px-2 py-1"
          >
            <option value="number">number</option>
            <option value="string">string</option>
            <option value="boolean">boolean</option>
            <option value="null">null</option>
            <option value="array">array</option>
            <option value="object">object</option>
          </select>
          <input
            type="number"
            value={String(value as number)}
            onChange={(e) => onChange(Number(e.target.value))}
            className="w-40 bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded-md px-2 py-1.5"
          />
        </div>
      </div>
    )
  }

  if (currentType === 'null') {
    return (
      <div className="rounded-lg bg-slate-900/40 ring-1 ring-slate-700/50 p-3 flex items-center justify-between gap-3">
        <FieldLabel path={path} depth={depth} />
        <select
          value={currentType}
          onChange={(e) => handleTypeChange(e.target.value as JsonType)}
          className="bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded-md px-2 py-1"
        >
          <option value="null">null</option>
          <option value="string">string</option>
          <option value="number">number</option>
          <option value="boolean">boolean</option>
          <option value="array">array</option>
          <option value="object">object</option>
        </select>
      </div>
    )
  }

  return (
    <div className="rounded-lg bg-slate-900/40 ring-1 ring-slate-700/50 p-3 flex items-center justify-between gap-3">
      <FieldLabel path={path} depth={depth} />
      <div className="flex items-center gap-2 w-[420px] max-w-full">
        <select
          value={currentType}
          onChange={(e) => handleTypeChange(e.target.value as JsonType)}
          className="bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded-md px-2 py-1"
        >
          <option value="string">string</option>
          <option value="number">number</option>
          <option value="boolean">boolean</option>
          <option value="null">null</option>
          <option value="array">array</option>
          <option value="object">object</option>
        </select>
        <input
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded-md px-2 py-1.5"
        />
      </div>
    </div>
  )
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return true
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item))
  if (t === 'object') {
    return Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item))
  }
  return false
}
