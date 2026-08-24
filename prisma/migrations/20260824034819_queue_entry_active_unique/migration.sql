-- CreateIndex
CREATE UNIQUE INDEX "queue_entry_active_unique" ON "QueueEntry"("simulationRunId") WHERE (status != 'EXPIRED');
