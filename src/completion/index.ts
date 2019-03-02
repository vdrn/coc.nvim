import { Buffer, Neovim } from '@chemzqm/neovim'
import { CancellationTokenSource, Disposable, MarkupKind } from 'vscode-languageserver-protocol'
import events from '../events'
import Document from '../model/document'
import sources from '../sources'
import { CompleteConfig, CompleteOption, PumBounding, RecentScore, VimCompleteItem, ISource } from '../types'
import { disposeAll, wait, echoErr } from '../util'
import { byteSlice, isWord, isTriggerCharacter, characterIndex } from '../util/string'
import workspace from '../workspace'
import Complete from './complete'
import FloatingWindow from './floating'
import { Chars } from '../model/chars'
const logger = require('../util/logger')('completion')

export interface LastInsert {
  character: string
  timestamp: number
}

export class Completion implements Disposable {
  public completeItems: VimCompleteItem[] = []
  public config: CompleteConfig
  private document: Document
  private floating: FloatingWindow
  // current input string
  private activted = false
  private input: string
  private lastInsert?: LastInsert
  private nvim: Neovim
  private disposables: Disposable[] = []
  private complete: Complete | null = null
  private recentScores: RecentScore = {}
  private resolveTokenSource: CancellationTokenSource
  private changedTick = 0
  private currIndex = 0
  private insertCharTs = 0
  private insertLeaveTs = 0
  // only used when no pum change event
  private isResolving = false
  private previewBuffer: Buffer

  public init(nvim: Neovim): void {
    this.nvim = nvim
    this.config = this.getCompleteConfig()
    events.on('InsertCharPre', this.onInsertCharPre, this, this.disposables)
    events.on('InsertLeave', this.onInsertLeave, this, this.disposables)
    events.on('InsertEnter', this.onInsertEnter, this, this.disposables)
    events.on('TextChangedP', this.onTextChangedP, this, this.disposables)
    events.on('TextChangedI', this.onTextChangedI, this, this.disposables)
    events.on('CompleteDone', this.onCompleteDone, this, this.disposables)
    events.on('PumRender', this.onPumRedraw, this, this.disposables)
    events.on('BufUnload', async bufnr => {
      if (this.previewBuffer && bufnr == this.previewBuffer.id) {
        let buf = this.previewBuffer
        await buf.setOption('buftype', 'nofile')
        await buf.setOption('bufhidden', 'hide')
      }
    }, null, this.disposables)
    workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('suggest')) {
        Object.assign(this.config, this.getCompleteConfig())
      }
    }, null, this.disposables)
  }

  public get option(): CompleteOption {
    if (!this.complete) return null
    return this.complete.option
  }

  public get index(): number {
    return this.currIndex
  }

  private addRecent(word: string, bufnr: number): void {
    if (!word) return
    this.recentScores[`${bufnr}|${word}`] = Date.now()
  }

  private async getPreviousContent(document: Document): Promise<string> {
    let [, lnum, col] = await this.nvim.call('getcurpos')
    if (this.option && lnum != this.option.linenr) return null
    let line = document.getline(lnum - 1)
    return col == 1 ? '' : byteSlice(line, 0, col - 1)
  }

  public async getResumeInput(): Promise<string> {
    let { option, document, activted } = this
    if (!activted) return null
    let [, lnum, col] = await this.nvim.call('getcurpos')
    if (lnum != option.linenr || col < option.col + 1) {
      return null
    }
    let line = document.getline(lnum - 1)
    return byteSlice(line, option.col, col - 1)
  }

  private get bufnr(): number {
    let { option } = this
    return option ? option.bufnr : null
  }

  public get isActivted(): boolean {
    return this.activted
  }

  private getCompleteConfig(): CompleteConfig {
    let config = workspace.getConfiguration('coc.preferences')
    let suggest = workspace.getConfiguration('suggest')
    function getConfig<T>(key, defaultValue: T): T {
      return config.get<T>(key, suggest.get<T>(key, defaultValue))
    }
    let keepCompleteopt = getConfig<boolean>('keepCompleteopt', false)
    let autoTrigger = getConfig<string>('autoTrigger', 'always')
    if (keepCompleteopt) {
      let { completeOpt } = workspace
      if (!completeOpt.includes('noinsert') && !completeOpt.includes('noselect')) {
        autoTrigger = 'none'
      }
    }
    let acceptSuggestionOnCommitCharacter = workspace.env.pumevent && getConfig<boolean>('acceptSuggestionOnCommitCharacter', false)
    return {
      autoTrigger,
      keepCompleteopt,
      acceptSuggestionOnCommitCharacter,
      previewIsKeyword: getConfig<string>('previewIsKeyword', '@,48-57,_192-255'),
      enablePreview: getConfig<boolean>('enablePreview', false),
      maxPreviewWidth: getConfig<number>('maxPreviewWidth', 50),
      triggerAfterInsertEnter: getConfig<boolean>('triggerAfterInsertEnter', false),
      noselect: getConfig<boolean>('noselect', true),
      numberSelect: getConfig<boolean>('numberSelect', false),
      maxItemCount: getConfig<number>('maxCompleteItemCount', 50),
      timeout: getConfig<number>('timeout', 500),
      minTriggerInputLength: getConfig<number>('minTriggerInputLength', 1),
      snippetIndicator: getConfig<string>('snippetIndicator', '~'),
      fixInsertedWord: getConfig<boolean>('fixInsertedWord', true),
      localityBonus: getConfig<boolean>('localityBonus', true),
    }
  }

  public async startCompletion(option: CompleteOption): Promise<void> {
    workspace.bufnr = option.bufnr
    let document = workspace.getDocument(option.bufnr)
    if (!document) return
    // use fixed filetype
    option.filetype = document.filetype
    this.document = document
    try {
      await this._doComplete(option)
    } catch (e) {
      this.stop()
      workspace.showMessage(`Error happens on complete: ${e.message}`, 'error')
      logger.error(e.stack)
    }
  }

  private async resumeCompletion(search: string | null, _isChangedP = false): Promise<void> {
    let { document, complete, activted } = this
    if (!activted || !complete.results || search == this.input) return
    let completeInput = complete.input
    if (search == null ||
      search.endsWith(' ') ||
      search.length < completeInput.length) {
      this.stop()
      return
    }
    let { changedtick } = document
    this.input = search
    let items: VimCompleteItem[]
    if (complete.isIncomplete) {
      await document.patchChange()
      document.forceSync()
      await wait(30)
      if (document.changedtick != changedtick) return
      items = await complete.completeInComplete(search)
      if (document.changedtick != changedtick) return
    } else {
      items = complete.filterResults(search)
    }
    if (!this.isActivted) return
    if (!items || items.length === 0) {
      this.stop()
      return
    }
    await this.showCompletion(this.option.col, items)
  }

  private appendNumber(items: VimCompleteItem[]): void {
    if (!this.config.numberSelect) return
    for (let i = 1; i <= 10; i++) {
      let item = items[i - 1]
      if (!item) break
      let idx = i == 10 ? 0 : i
      item.abbr = item.abbr ? `${idx} ${item.abbr}` : `${idx} ${item.word}`
    }
  }

  public async hasSelected(): Promise<boolean> {
    if (workspace.env.pumevent) return this.currIndex !== 0
    if (this.config.noselect === false) return true
    return this.isResolving
  }

  private async showCompletion(col: number, items: VimCompleteItem[]): Promise<void> {
    let { nvim, document } = this
    this.appendNumber(items)
    this.changedTick = document.changedtick
    if (this.config.numberSelect) {
      nvim.call('coc#_map', [], true)
    }
    nvim.call('coc#_do_complete', [col, items], true)
    this.completeItems = items
  }

  private async _doComplete(option: CompleteOption): Promise<void> {
    let { line, colnr, filetype, source } = option
    let { nvim, config } = this
    // current input
    this.input = option.input
    let pre = byteSlice(line, 0, colnr - 1)
    let isTriggered = source == null && pre && !this.document.isWord(pre[pre.length - 1]) && sources.shouldTrigger(pre, filetype)
    let arr: ISource[] = []
    if (source == null) {
      arr = sources.getCompleteSources(option, isTriggered)
    } else {
      let s = sources.getSource(source)
      if (s) arr.push(s)
    }
    if (!arr.length) return
    let complete = new Complete(option, this.document, this.recentScores, config, nvim)
    this.start(complete)
    let items = await this.complete.doComplete(arr)
    if (complete.isCanceled || !this.isActivted) return
    if (items.length == 0) {
      this.stop()
      return
    }
    let search = await this.getResumeInput()
    if (complete.isCanceled) return
    if (search == option.input) {
      await this.showCompletion(option.col, items)
      return
    }
    await this.resumeCompletion(search)
  }

  private async onTextChangedP(): Promise<void> {
    let { option, document } = this
    if (!option) return
    await document.patchChange()
    let hasInsert = this.latestInsert != null
    this.lastInsert = null
    // avoid trigger filter on pumvisible
    if (document.changedtick == this.changedTick) return
    if (!hasInsert) {
      // this could be wrong, but can't avoid.
      this.isResolving = true
      return
    }
    let col = await this.nvim.call('col', '.')
    let line = document.getline(option.linenr - 1)
    let ind = option.line.match(/^\s*/)[0]
    let curr = line.match(/^\s*/)[0]
    // fix option when vim does indent
    if (ind.length != curr.length) {
      let newCol = option.col + curr.length - ind.length
      if (newCol > col - 1) return
      let newLine = curr + option.line.slice(ind.length)
      let colnr = option.colnr + curr.length - ind.length
      Object.assign(option, { col: newCol, line: newLine, colnr })
    }
    let search = byteSlice(line, option.col, col - 1)
    await this.resumeCompletion(search, true)
  }

  private async onTextChangedI(bufnr: number): Promise<void> {
    let { nvim, latestInsertChar } = this
    this.lastInsert = null
    let document = workspace.getDocument(workspace.bufnr)
    if (!document) return
    await document.patchChange()
    if (!this.isActivted) {
      if (!latestInsertChar) return
      // check trigger
      let pre = await this.getPreviousContent(document)
      let last = pre ? pre.slice(-1) : ''
      if (!/\s/.test(last)) await this.triggerCompletion(document, pre)
      return
    }
    if (bufnr !== this.bufnr) return
    // check commit character
    if (this.config.acceptSuggestionOnCommitCharacter
      && latestInsertChar
      && !this.document.isWord(latestInsertChar)) {
      let item = this.currIndex ? this.completeItems[this.currIndex - 1] : this.completeItems[0]
      if (sources.shouldCommit(item, latestInsertChar)) {
        let { linenr, col, line, colnr } = this.option
        this.stop()
        let { word } = item
        let newLine = `${line.slice(0, col)}${word}${latestInsertChar}${line.slice(colnr - 1)}`
        await nvim.call('coc#util#setline', [linenr, newLine])
        let curcol = col + word.length + 2
        await nvim.call('cursor', [linenr, curcol])
        return
      }
    }
    let content = await this.getPreviousContent(document)
    if (content == null) {
      // cursor line changed
      this.stop()
      return
    }
    let character = content.slice(-1)
    // check trigger character
    if (isTriggerCharacter(character) && sources.shouldTrigger(content, document.filetype)) {
      let option: CompleteOption = await this.nvim.call('coc#util#get_complete_option')
      option.triggerCharacter = character
      logger.debug('trigger completion with', option)
      await this.startCompletion(option)
      return
    }
    if (!this.isActivted) return
    let search = content.slice(characterIndex(content, this.option.col))
    return await this.resumeCompletion(search)
  }

  private async triggerCompletion(document: Document, pre: string): Promise<void> {
    // check trigger
    let shouldTrigger = await this.shouldTrigger(document, pre)
    if (!shouldTrigger) return
    let option: CompleteOption = await this.nvim.call('coc#util#get_complete_option')
    option.triggerCharacter = pre[pre.length - 1]
    logger.debug('trigger completion with', option)
    await this.startCompletion(option)
  }

  private async onCompleteDone(item: VimCompleteItem): Promise<void> {
    let { document, nvim } = this
    if (!this.isActivted || !document || item.word == null) return
    let opt = Object.assign({}, this.option)
    item = this.completeItems.find(o => o.word == item.word && o.user_data == item.user_data)
    this.stop()
    if (!item) return
    let timestamp = this.insertCharTs
    let insertLeaveTs = this.insertLeaveTs
    try {
      await sources.doCompleteResolve(item, (new CancellationTokenSource()).token)
      this.addRecent(item.word, document.bufnr)
      await wait(50)
      let mode = await nvim.call('mode')
      if (mode != 'i' || this.insertCharTs != timestamp || this.insertLeaveTs != insertLeaveTs) return
      await document.patchChange()
      let content = await this.getPreviousContent(document)
      if (!content.endsWith(item.word)) return
      await sources.doCompleteDone(item, opt)
      document.forceSync()
    } catch (e) {
      // tslint:disable-next-line:no-console
      console.error(e.stack)
      logger.error(`error on complete done`, e.stack)
    }
  }

  private async onInsertLeave(bufnr: number): Promise<void> {
    this.insertLeaveTs = Date.now()
    let doc = workspace.getDocument(bufnr)
    if (doc) doc.forceSync(true)
    this.stop()
  }

  private async onInsertEnter(): Promise<void> {
    if (!this.config.triggerAfterInsertEnter) return
    let option = await this.nvim.call('coc#util#get_complete_option')
    if (option.input.length >= this.config.minTriggerInputLength) {
      await this.startCompletion(option)
    }
  }

  private async onInsertCharPre(character: string): Promise<void> {
    if (this.isActivted
      && !workspace.env.pumevent
      && !workspace.env.isVim
      && this.completeItems.length
      && isWord(character)
      && !global.hasOwnProperty('__TEST__')) {
      await this.nvim.call('coc#_reload', [])
    }
    this.lastInsert = {
      character,
      timestamp: Date.now(),
    }
    this.insertCharTs = this.lastInsert.timestamp
  }

  private get latestInsert(): LastInsert | null {
    let { lastInsert } = this
    if (!lastInsert || Date.now() - lastInsert.timestamp > 100) {
      return null
    }
    return lastInsert
  }

  private get latestInsertChar(): string {
    let { latestInsert } = this
    if (!latestInsert) return ''
    return latestInsert.character
  }

  public async shouldTrigger(document: Document, pre: string): Promise<boolean> {
    if (!pre || pre.trim() == '') return false
    let autoTrigger = this.config.autoTrigger
    if (autoTrigger == 'none') return false
    if (sources.shouldTrigger(pre, document.filetype)) return true
    if (autoTrigger !== 'always') return false
    if (document.isWord(pre.slice(-1))) {
      let minLength = this.config.minTriggerInputLength
      if (minLength == 1) return true
      let input = this.getInput(document, pre)
      return input.length >= minLength
    }
    return false
  }

  public async onPumRedraw(item: VimCompleteItem, bounding: PumBounding): Promise<void> {
    if (!workspace.env.floating) return
    if (this.resolveTokenSource) {
      this.resolveTokenSource.cancel()
      this.resolveTokenSource = null
    }
    // it's pum change by vim, ignore it
    if (this.lastInsert) return
    let currItem = this.completeItems.find(o => o.word == item.word && o.user_data == item.user_data)
    if (!currItem) {
      this.currIndex = 0
      this.closePreviewWindow()
      return
    }
    this.currIndex = this.completeItems.indexOf(currItem) + 1
    let source = this.resolveTokenSource = new CancellationTokenSource()
    let { token } = source
    await sources.doCompleteResolve(currItem, token)
    if (token.isCancellationRequested) return
    let content = currItem.documentation ? currItem.documentation.value : currItem.info
    if (!content) {
      this.closePreviewWindow()
    } else {
      if (!this.previewBuffer) await this.createPreviewBuffer()
      if (!this.floating) {
        let srcId = await workspace.createNameSpace('coc-pum')
        let chars = new Chars(this.config.previewIsKeyword)
        let config = { srcId, maxPreviewWidth: this.config.maxPreviewWidth, chars }
        this.floating = new FloatingWindow(this.nvim, this.previewBuffer, config)
      }
      let kind: MarkupKind = currItem.documentation && currItem.documentation.kind == 'markdown' ? 'markdown' : 'plaintext'
      await wait(10)
      if (token.isCancellationRequested || !this.isActivted) return
      await this.floating.show(content, bounding, kind, currItem.hasDetail)
    }
    this.resolveTokenSource = null
  }

  private async createPreviewBuffer(): Promise<void> {
    let buf = this.previewBuffer = await this.nvim.createNewBuffer(false)
    await buf.setOption('buftype', 'nofile')
    await buf.setOption('bufhidden', 'hide')
  }

  public start(complete: Complete): void {
    let { activted } = this
    this.activted = true
    this.isResolving = false
    this.closePreviewWindow()
    if (activted) {
      this.complete.cancel()
    }
    this.complete = complete
    this.completeItems = []
    if (!this.config.keepCompleteopt) {
      this.nvim.command(`noa set completeopt=${this.completeOpt}`, true)
    }
    this.document.forceSync(true)
    this.document.paused = true
  }

  public stop(): void {
    let { nvim } = this
    if (!this.activted) return
    if (this.resolveTokenSource) {
      this.resolveTokenSource.cancel()
      this.resolveTokenSource = null
    }
    this.closePreviewWindow()
    this.activted = false
    this.document.paused = false
    this.document.fireContentChanges()
    this.completeItems = []
    if (this.complete) {
      this.complete.cancel()
      this.complete = null
    }
    if (this.config.numberSelect) {
      nvim.call('coc#_unmap', [], true)
    }
    nvim.call('coc#_hide', [], true)
    if (!this.config.keepCompleteopt) {
      this.nvim.command(`noa set completeopt=${workspace.completeOpt}`, true)
    }
  }

  private closePreviewWindow(): void {
    if (this.floating) {
      this.floating.close()
      this.floating = null
    }
  }

  private getInput(document: Document, pre: string): string {
    let input = ''
    for (let i = pre.length - 1; i >= 0; i--) {
      let ch = i == 0 ? null : pre[i - 1]
      if (!ch || !document.isWord(ch)) {
        input = pre.slice(i, pre.length)
        break
      }
    }
    return input
  }

  private get completeOpt(): string {
    let { noselect, enablePreview } = this.config
    if (noselect) return `noselect,menuone${enablePreview ? ',preview' : ''}`
    return `noinsert,menuone${enablePreview ? ',preview' : ''}`
  }

  public dispose(): void {
    disposeAll(this.disposables)
  }
}

export default new Completion()
