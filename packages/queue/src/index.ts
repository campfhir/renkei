/**
 * @renkei/queue — Renkei's queues behind a broker-agnostic contract.
 *
 * `contract.ts` defines what a queue IS (leases, ack/nack, retry, ordering
 * keys, a dead-letter store); `postgres.ts` carries it on the tables of
 * migrations 013/030; `memory.ts` carries it on arrays for tests. A future
 * RabbitMQ/Kafka adapter slots in beside them without touching a producer
 * or consumer.
 */

export type {
  ClaimedMessage,
  DeadLetter,
  DeadLetterStore,
  Disposition,
  Queue,
  QueueConsumer,
  QueueMessageInput,
  QueueProducer,
  QueuePurger,
} from './contract';
export { failureDisposition, DEFAULT_RETRY_POLICY, type RetryPolicy } from './policy';
export {
  createPostgresQueue,
  webhookEventsQueue,
  embeddingJobsQueue,
  agentJobsQueue,
  type PostgresQueueConfig,
} from './postgres';
export { InMemoryQueue, type MemoryMessage, type InMemoryQueueOptions } from './memory';
