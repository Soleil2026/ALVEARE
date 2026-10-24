-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "documents";

-- CreateTable
CREATE TABLE "documents"."Document" (
    "id" BIGSERIAL NOT NULL,
    "ownerSub" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storedPath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents"."ShareToken" (
    "id" BIGSERIAL NOT NULL,
    "jti" TEXT NOT NULL,
    "documentId" BIGINT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShareToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Document_ownerSub_createdAt_idx" ON "documents"."Document"("ownerSub", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShareToken_jti_key" ON "documents"."ShareToken"("jti");

-- CreateIndex
CREATE INDEX "ShareToken_documentId_revokedAt_idx" ON "documents"."ShareToken"("documentId", "revokedAt");

-- AddForeignKey
ALTER TABLE "documents"."ShareToken" ADD CONSTRAINT "ShareToken_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"."Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
