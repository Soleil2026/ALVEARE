-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "notify";

-- CreateTable
CREATE TABLE "notify"."Notification" (
    "id" BIGSERIAL NOT NULL,
    "channel" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "lang" TEXT NOT NULL,
    "recipientHash" TEXT NOT NULL,
    "recipientCipher" TEXT NOT NULL,
    "via" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dedupKey" TEXT,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Notification_dedupKey_key" ON "notify"."Notification"("dedupKey");

-- CreateIndex
CREATE INDEX "Notification_recipientHash_createdAt_idx" ON "notify"."Notification"("recipientHash", "createdAt");
