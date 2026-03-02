#!/usr/bin/env npx tsx
/**
 * Backfill Graph Memory
 *
 * Processes existing memory rows to:
 * 1. Generate vector embeddings → memory_embeddings
 * 2. Extract entities from subject + content → entities
 * 3. Create memory_entity_links
 *
 * Usage:
 *   npx tsx scripts/backfill-graph-memory.ts
 *
 * Required env vars:
 *   OPENROUTER_API_KEY          — OpenRouter API key
 *   NEXT_PUBLIC_SUPABASE_URL    — Supabase URL
 *   SUPABASE_SERVICE_ROLE_KEY   — Supabase service role key
 *
 * Cost estimate: ~$0.20 per 1000 memories
 */

import { createClient } from '@supabase/supabase-js'

// ─── Config ──────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'openai/text-embedding-3-small'
const EXTRACTOR_MODEL = process.env.EXTRACTOR_MODEL || 'openai/gpt-4o-mini'
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1'

const BATCH_SIZE = 20
const RATE_LIMIT_DELAY_MS = 500 // Delay between batches to avoid rate limits

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

if (!OPENROUTER_API_KEY) {
  console.error('Missing OPENROUTER_API_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ─── OpenRouter Helpers ─────────────────────────────────────────────────

async function generateEmbedding(text: string): Promise<number[] | null> {
  const response = await fetch(`${LLM_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
      'X-Title': 'Captain Backfill',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text.slice(0, 8000),
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    console.error(`Embedding failed: ${response.status} ${err}`)
    return null
  }

  const data = await response.json()
  return data.data?.[0]?.embedding ?? null
}

async function extractEntities(
  text: string
): Promise<{ entities: Array<{ name: string; type: string; description?: string }> }> {
  const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
      'X-Title': 'Captain Backfill',
    },
    body: JSON.stringify({
      model: EXTRACTOR_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'Extract entities mentioned in this text. Return JSON: { "entities": [{ "name": "Full Name", "type": "person|project|control|decision|team|tool|vendor|framework|document|process", "description": "brief" }] }. Only extract clearly identifiable entities. Return empty array if none.',
        },
        { role: 'user', content: text },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 1000,
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    console.error(`Extraction failed: ${response.status} ${err}`)
    return { entities: [] }
  }

  const data = await response.json()
  const content = data.choices?.[0]?.message?.content
  if (!content) return { entities: [] }

  try {
    return JSON.parse(content)
  } catch {
    return { entities: [] }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Backfill Graph Memory ===\n')

  // Get all memories that don't have embeddings yet
  const { data: memories, error } = await supabase
    .from('memory')
    .select('id, org_id, subject, content, related_entities')
    .order('created_at', { ascending: true })

  if (error) {
    console.error('Failed to fetch memories:', error.message)
    process.exit(1)
  }

  if (!memories || memories.length === 0) {
    console.log('No memories found to backfill.')
    return
  }

  console.log(`Found ${memories.length} memories to process.\n`)

  let embeddingsCreated = 0
  let entitiesCreated = 0
  let linksCreated = 0
  let errors = 0

  // Process in batches
  for (let i = 0; i < memories.length; i += BATCH_SIZE) {
    const batch = memories.slice(i, i + BATCH_SIZE)
    console.log(`\nBatch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(memories.length / BATCH_SIZE)} (${batch.length} memories)`)

    for (const memory of batch) {
      const memText = `${memory.subject || ''}: ${memory.content || ''}`

      try {
        // 1. Generate embedding
        const { data: existingEmb } = await supabase
          .from('memory_embeddings')
          .select('id')
          .eq('memory_id', memory.id)
          .single()

        if (!existingEmb) {
          const embedding = await generateEmbedding(memText)
          if (embedding) {
            const { error: embError } = await supabase
              .from('memory_embeddings')
              .insert({ memory_id: memory.id, embedding: JSON.stringify(embedding) })

            if (!embError) {
              embeddingsCreated++
            } else {
              console.warn(`  Embedding insert failed for ${memory.id}: ${embError.message}`)
            }
          }
        }

        // 2. Extract and upsert entities
        if (memText.trim().length > 20) {
          const { entities } = await extractEntities(memText)
          const validTypes = new Set([
            'person', 'project', 'control', 'decision', 'team',
            'tool', 'vendor', 'framework', 'document', 'process',
          ])

          for (const entity of entities) {
            if (!validTypes.has(entity.type)) continue

            const canonical = entity.name.toLowerCase().trim().replace(/\s+/g, ' ')

            // Upsert entity
            const { data: existing } = await supabase
              .from('entities')
              .select('id, mention_count')
              .eq('org_id', memory.org_id)
              .eq('canonical_name', canonical)
              .eq('entity_type', entity.type)
              .single()

            let entityId: string

            if (existing) {
              await supabase
                .from('entities')
                .update({
                  mention_count: existing.mention_count + 1,
                  last_seen_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                })
                .eq('id', existing.id)
              entityId = existing.id
            } else {
              const { data: newEntity } = await supabase
                .from('entities')
                .insert({
                  org_id: memory.org_id,
                  entity_type: entity.type,
                  name: entity.name,
                  canonical_name: canonical,
                  description: entity.description ?? null,
                  attributes: {},
                })
                .select('id')
                .single()

              if (!newEntity) continue
              entityId = newEntity.id
              entitiesCreated++
            }

            // 3. Create memory_entity_link
            const { error: linkError } = await supabase
              .from('memory_entity_links')
              .upsert(
                { memory_id: memory.id, entity_id: entityId },
                { onConflict: 'memory_id,entity_id' }
              )

            if (!linkError) linksCreated++
          }
        }

        process.stdout.write('.')
      } catch (err) {
        errors++
        console.error(`\n  Error processing memory ${memory.id}:`, (err as Error).message)
      }
    }

    // Rate limit delay between batches
    if (i + BATCH_SIZE < memories.length) {
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY_MS))
    }
  }

  console.log('\n\n=== Backfill Complete ===')
  console.log(`  Embeddings created: ${embeddingsCreated}`)
  console.log(`  Entities created:   ${entitiesCreated}`)
  console.log(`  Links created:      ${linksCreated}`)
  console.log(`  Errors:             ${errors}`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
