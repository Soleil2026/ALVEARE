-- CreateTable
CREATE TABLE "RoleGrant" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "app" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "RoleGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Consent" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "consumingApp" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Consent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoleGrant_app_role_idx" ON "RoleGrant"("app", "role");

-- CreateIndex
CREATE UNIQUE INDEX "RoleGrant_userId_app_key" ON "RoleGrant"("userId", "app");

-- CreateIndex
CREATE INDEX "Consent_userId_revokedAt_idx" ON "Consent"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Consent_userId_consumingApp_scope_key" ON "Consent"("userId", "consumingApp", "scope");
