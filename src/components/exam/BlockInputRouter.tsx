import type { BlockConfig } from '../../types'
import { BrainDumpBlock } from './blocks/BrainDumpBlock'
import { VocabWritingBlock } from './blocks/VocabWritingBlock'
import { SpeakingBlock } from './blocks/SpeakingBlock'
import { MockTestBlock } from './blocks/MockTestBlock'
import { CustomBlock } from './blocks/CustomBlock'

interface BlockInputRouterProps {
  block: BlockConfig
}

/**
 * BlockInputRouter — Renders the correct input component for each block type.
 * Acts as a switch that plugs into the timer shell (SessionRunner).
 */
export function BlockInputRouter({ block }: BlockInputRouterProps) {
  switch (block.type) {
    case 'brain-dump':
      return <BrainDumpBlock block={block} />
    case 'vocab-writing':
      return <VocabWritingBlock block={block} />
    case 'speaking':
      return <SpeakingBlock block={block} />
    case 'mock-test':
      return <MockTestBlock block={block} />
    case 'custom':
      return <CustomBlock block={block} />
    default:
      return (
        <div className="text-center py-8 text-slate-400">
          Unknown block type: {(block as BlockConfig).type}
        </div>
      )
  }
}

