import { useEffect, useState } from 'react'

import { MODEL_API_VALUES } from '../../../shared/contracts/model-config'
import type { ModelEntryView, ProviderView } from '../../../shared/contracts/model-config'
import { formatTokens } from '../../lib/format'
import { useModelAdminStore } from '../../stores/modelAdminStore'
import { useSessionStore } from '../../stores/sessionStore'

/**
 * 模型管理弹层（M7）。
 *
 * 管的是**磁盘上的 pi 配置**（`<agent-dir>/models.json` + `settings.json#defaultModel`），
 * 与「会话内切换模型」是两件事：这里改完，**已在跑的会话不变**，要新开会话才生效。
 *
 * 安全口径：
 * - apiKey 只写不读：编辑已有 provider 时输入框永远空白，占位提示「已配置（留空=保留）」，
 *   要清除就显式点「清除 key」；
 * - 界面上显示的是后端给的掩码（`apiKeyHint`），明文从未进入渲染进程。
 */
export interface ModelManagerProps {
  onClose: () => void
}

interface ModelDraft {
  id: string
  name: string
  contextWindow: string
  maxTokens: string
  reasoning: boolean
}

interface ProviderDraft {
  id: string
  name: string
  baseUrl: string
  api: string
  apiKey: string
  clearApiKey: boolean
  models: ModelDraft[]
}

const EMPTY_MODEL: ModelDraft = {
  id: '',
  name: '',
  contextWindow: '',
  maxTokens: '',
  reasoning: false
}

function emptyDraft(): ProviderDraft {
  return {
    id: '',
    name: '',
    baseUrl: '',
    api: 'openai-completions',
    apiKey: '',
    clearApiKey: false,
    models: [{ ...EMPTY_MODEL }]
  }
}

function draftFromProvider(provider: ProviderView): ProviderDraft {
  return {
    id: provider.id,
    name: provider.name ?? '',
    baseUrl: provider.baseUrl ?? '',
    api: provider.api ?? 'openai-completions',
    apiKey: '',
    clearApiKey: false,
    models:
      provider.models.length === 0
        ? [{ ...EMPTY_MODEL }]
        : provider.models.map((model) => ({
            id: model.id,
            name: model.name ?? '',
            contextWindow: model.contextWindow === undefined ? '' : String(model.contextWindow),
            maxTokens: model.maxTokens === undefined ? '' : String(model.maxTokens),
            reasoning: model.reasoning === true
          }))
  }
}

/** 空字符串 → undefined（zod 的 optional 不接受 `''`）；非数字输入保持 undefined 让后端报错 */
function optionalNumber(value: string): number | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function modelSummary(model: ModelEntryView): string {
  const bits: string[] = []
  if (model.contextWindow !== undefined) bits.push(`ctx ${formatTokens(model.contextWindow)}`)
  if (model.maxTokens !== undefined) bits.push(`max ${formatTokens(model.maxTokens)}`)
  if (model.reasoning === true) bits.push('thinking')
  return bits.join(' · ')
}

export function ModelManager({ onClose }: ModelManagerProps): React.JSX.Element {
  const view = useModelAdminStore((state) => state.view)
  const loading = useModelAdminStore((state) => state.loading)
  const saving = useModelAdminStore((state) => state.saving)
  const error = useModelAdminStore((state) => state.error)
  const load = useModelAdminStore((state) => state.load)
  const clearError = useModelAdminStore((state) => state.clearError)
  const setDefault = useModelAdminStore((state) => state.setDefault)
  const upsertProvider = useModelAdminStore((state) => state.upsertProvider)
  const removeProvider = useModelAdminStore((state) => state.removeProvider)

  // 会话里可用模型（pi RPC）——默认模型下拉用它，避免让用户手打 id
  const sessionModels = useSessionStore((state) => state.models)

  const [draft, setDraft] = useState<ProviderDraft | undefined>(undefined)
  const [editingExisting, setEditingExisting] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<string | undefined>(undefined)

  useEffect(() => {
    void load()
  }, [load])

  const submitDraft = async (): Promise<void> => {
    if (draft === undefined) return
    const models = draft.models
      .filter((model) => model.id.trim().length > 0)
      .map((model) => ({
        id: model.id.trim(),
        ...(model.name.trim().length === 0 ? {} : { name: model.name.trim() }),
        ...(optionalNumber(model.contextWindow) === undefined
          ? {}
          : { contextWindow: optionalNumber(model.contextWindow) }),
        ...(optionalNumber(model.maxTokens) === undefined
          ? {}
          : { maxTokens: optionalNumber(model.maxTokens) }),
        ...(model.reasoning ? { reasoning: true } : {})
      }))

    const ok = await upsertProvider({
      id: draft.id.trim(),
      ...(draft.name.trim().length === 0 ? {} : { name: draft.name.trim() }),
      ...(draft.baseUrl.trim().length === 0 ? {} : { baseUrl: draft.baseUrl.trim() }),
      ...(draft.api.trim().length === 0
        ? {}
        : { api: draft.api as (typeof MODEL_API_VALUES)[number] }),
      ...(draft.clearApiKey ? { apiKey: '' } : {}),
      ...(draft.apiKey.trim().length === 0 || draft.clearApiKey ? {} : { apiKey: draft.apiKey }),
      models
    })
    if (ok) {
      setDraft(undefined)
      setEditingExisting(false)
    }
  }

  return (
    <div className="modal-backdrop" data-testid="models-manager">
      <section className="modal modal--wide" role="dialog" aria-modal="true" aria-label="模型管理">
        <header className="modal__header">
          <h2>模型管理</h2>
          <button
            type="button"
            className="btn btn--ghost"
            data-testid="models-close"
            onClick={onClose}
          >
            关闭
          </button>
        </header>

        <div className="modal__body">
          {error === undefined ? null : (
            <div className="models__error" data-testid="models-error" role="alert">
              <span>{error}</span>
              <button type="button" className="btn btn--ghost" onClick={clearError}>
                知道了
              </button>
            </div>
          )}

          <p className="settings__note">
            这里改的是 pi 的配置文件（<code>{view?.configPath ?? '<agent-dir>/models.json'}</code>
            ）；<strong>已在运行的会话不受影响</strong>，新开会话才会用新配置。
          </p>

          <div className="models__section">
            <h3>默认模型</h3>
            <div className="field__row">
              <select
                className="field__input"
                data-testid="models-default-select"
                value={view?.defaultModel ?? ''}
                disabled={loading || saving}
                onChange={(event) => {
                  const value = event.target.value
                  void setDefault(value === '' ? null : value)
                }}
              >
                <option value="">自动（由 pi 决定）</option>
                {(sessionModels.length > 0
                  ? sessionModels.map((model) => model.id)
                  : (view?.providers ?? []).flatMap((provider) =>
                      provider.models.map((model) => model.id)
                    )
                )
                  .filter((id, index, list) => list.indexOf(id) === index)
                  .map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                {view?.defaultModel !== undefined &&
                !sessionModels.some((model) => model.id === view.defaultModel) &&
                !(view?.providers ?? []).some((provider) =>
                  provider.models.some((model) => model.id === view?.defaultModel)
                ) ? (
                  <option value={view.defaultModel}>{view.defaultModel}（配置文件里的值）</option>
                ) : null}
              </select>
              <span className="settings__note">
                新会话的启动模型（写入 settings.json#defaultModel）
              </span>
            </div>
          </div>

          <div className="models__section">
            <h3>
              Provider（{view?.providers.length ?? 0}）
              <button
                type="button"
                className="btn btn--ghost"
                data-testid="models-add-provider"
                onClick={() => {
                  setDraft(emptyDraft())
                  setEditingExisting(false)
                }}
              >
                新增
              </button>
            </h3>

            {view === undefined || view.providers.length === 0 ? (
              <p className="settings__note" data-testid="models-empty">
                还没有自定义 provider。内置 provider 由 pi 自带，这里只列 `models.json` 里的条目。
              </p>
            ) : (
              <ul className="models__list">
                {view.providers.map((provider) => (
                  <li
                    key={provider.id}
                    className="models__provider"
                    data-testid="models-provider-row"
                  >
                    <div className="models__provider-head">
                      <strong>{provider.id}</strong>
                      {provider.name === undefined ? null : (
                        <span className="models__muted">{provider.name}</span>
                      )}
                      {provider.hasApiKey ? (
                        <span className="badge" title="apiKey 已配置（明文不显示）">
                          key {provider.apiKeyHint}
                        </span>
                      ) : (
                        <span className="badge badge--warn">无 key</span>
                      )}
                      {provider.baseUrl === undefined ? null : (
                        <span className="models__muted">{provider.baseUrl}</span>
                      )}
                      <span className="models__spacer" />
                      <button
                        type="button"
                        className="btn btn--ghost"
                        data-testid="models-provider-edit"
                        onClick={() => {
                          setDraft(draftFromProvider(provider))
                          setEditingExisting(true)
                        }}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        data-testid="models-provider-delete"
                        onClick={() => {
                          setPendingDelete(provider.id)
                        }}
                      >
                        删除
                      </button>
                    </div>
                    <ul className="models__models">
                      {provider.models.map((model) => (
                        <li key={model.id}>
                          <code>{model.id}</code>
                          <span className="models__muted">{modelSummary(model)}</span>
                          {model.hasExtraFields ? (
                            <span
                              className="models__muted"
                              title="还有客户端未建模的字段，编辑不会清掉"
                            >
                              （含额外字段）
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>

                    {pendingDelete === provider.id ? (
                      <div className="models__confirm" data-testid="models-provider-confirm">
                        <span>
                          删除 provider <code>{provider.id}</code>？会从 models.json
                          里移除整段配置。
                        </span>
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => {
                            setPendingDelete(undefined)
                          }}
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          className="btn btn--primary"
                          data-testid="models-provider-confirm-yes"
                          onClick={() => {
                            setPendingDelete(undefined)
                            void removeProvider(provider.id)
                          }}
                        >
                          删除
                        </button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {draft === undefined ? null : (
            <div className="models__section models__form" data-testid="models-form">
              <h3>{editingExisting ? `编辑 provider：${draft.id}` : '新增 provider'}</h3>
              <div className="models__grid">
                <label>
                  <span>Provider ID</span>
                  <input
                    className="field__input"
                    data-testid="models-form-id"
                    value={draft.id}
                    disabled={editingExisting}
                    placeholder="acme"
                    onChange={(event) => {
                      setDraft({ ...draft, id: event.target.value })
                    }}
                  />
                </label>
                <label>
                  <span>显示名（可选）</span>
                  <input
                    className="field__input"
                    data-testid="models-form-name"
                    value={draft.name}
                    onChange={(event) => {
                      setDraft({ ...draft, name: event.target.value })
                    }}
                  />
                </label>
                <label>
                  <span>Base URL</span>
                  <input
                    className="field__input"
                    data-testid="models-form-baseurl"
                    value={draft.baseUrl}
                    placeholder="https://api.example.com/v1"
                    onChange={(event) => {
                      setDraft({ ...draft, baseUrl: event.target.value })
                    }}
                  />
                </label>
                <label>
                  <span>API 类型</span>
                  <select
                    className="field__input"
                    data-testid="models-form-api"
                    value={draft.api}
                    onChange={(event) => {
                      setDraft({ ...draft, api: event.target.value })
                    }}
                  >
                    {MODEL_API_VALUES.map((api) => (
                      <option key={api} value={api}>
                        {api}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="models__wide">
                  <span>
                    API Key
                    {editingExisting ? '（留空 = 保留现有）' : ''}
                  </span>
                  <input
                    className="field__input"
                    type="password"
                    autoComplete="off"
                    data-testid="models-form-apikey"
                    value={draft.apiKey}
                    placeholder={editingExisting ? '已配置（不显示明文）' : '$ENV_VAR 或 sk-…'}
                    onChange={(event) => {
                      setDraft({ ...draft, apiKey: event.target.value, clearApiKey: false })
                    }}
                  />
                </label>
                {editingExisting ? (
                  <label className="models__check models__wide">
                    <input
                      type="checkbox"
                      data-testid="models-form-clear-key"
                      checked={draft.clearApiKey}
                      onChange={(event) => {
                        setDraft({ ...draft, apiKey: '', clearApiKey: event.target.checked })
                      }}
                    />
                    <span>清除已配置的 key</span>
                  </label>
                ) : null}
              </div>

              <h4>模型</h4>
              <table className="models__table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>名称</th>
                    <th>上下文</th>
                    <th>最大输出</th>
                    <th>thinking</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {draft.models.map((model, index) => (
                    <tr key={`model-row-${index}`}>
                      <td>
                        <input
                          className="field__input"
                          data-testid={`models-form-model-id-${index}`}
                          value={model.id}
                          onChange={(event) => {
                            const models = [...draft.models]
                            models[index] = { ...model, id: event.target.value }
                            setDraft({ ...draft, models })
                          }}
                        />
                      </td>
                      <td>
                        <input
                          className="field__input"
                          data-testid={`models-form-model-name-${index}`}
                          value={model.name}
                          onChange={(event) => {
                            const models = [...draft.models]
                            models[index] = { ...model, name: event.target.value }
                            setDraft({ ...draft, models })
                          }}
                        />
                      </td>
                      <td>
                        <input
                          className="field__input"
                          inputMode="numeric"
                          data-testid={`models-form-model-ctx-${index}`}
                          value={model.contextWindow}
                          onChange={(event) => {
                            const models = [...draft.models]
                            models[index] = { ...model, contextWindow: event.target.value }
                            setDraft({ ...draft, models })
                          }}
                        />
                      </td>
                      <td>
                        <input
                          className="field__input"
                          inputMode="numeric"
                          data-testid={`models-form-model-max-${index}`}
                          value={model.maxTokens}
                          onChange={(event) => {
                            const models = [...draft.models]
                            models[index] = { ...model, maxTokens: event.target.value }
                            setDraft({ ...draft, models })
                          }}
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          data-testid={`models-form-model-reasoning-${index}`}
                          checked={model.reasoning}
                          onChange={(event) => {
                            const models = [...draft.models]
                            models[index] = { ...model, reasoning: event.target.checked }
                            setDraft({ ...draft, models })
                          }}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => {
                            const models = draft.models.filter((_item, at) => at !== index)
                            setDraft({
                              ...draft,
                              models: models.length === 0 ? [{ ...EMPTY_MODEL }] : models
                            })
                          }}
                        >
                          移除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="field__row">
                <button
                  type="button"
                  className="btn btn--ghost"
                  data-testid="models-form-add-model"
                  onClick={() => {
                    setDraft({ ...draft, models: [...draft.models, { ...EMPTY_MODEL }] })
                  }}
                >
                  再加一个模型
                </button>
                <span className="models__spacer" />
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    setDraft(undefined)
                    setEditingExisting(false)
                  }}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  data-testid="models-form-save"
                  disabled={saving || draft.id.trim().length === 0}
                  onClick={() => {
                    void submitDraft()
                  }}
                >
                  {saving ? '保存中…' : '保存'}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
