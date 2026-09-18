-- CreateTable
CREATE TABLE "WorkspaceTag" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "group" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "WorkspaceTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_PrinterTags" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_PrinterTags_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_LibraryFileTags" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_LibraryFileTags_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_SpoolTags" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_SpoolTags_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceTag_workspaceId_nameKey_key" ON "WorkspaceTag"("workspaceId", "nameKey");

-- CreateIndex
CREATE INDEX "_PrinterTags_B_index" ON "_PrinterTags"("B");

-- CreateIndex
CREATE INDEX "_LibraryFileTags_B_index" ON "_LibraryFileTags"("B");

-- CreateIndex
CREATE INDEX "_SpoolTags_B_index" ON "_SpoolTags"("B");

-- AddForeignKey
ALTER TABLE "WorkspaceTag" ADD CONSTRAINT "WorkspaceTag_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PrinterTags" ADD CONSTRAINT "_PrinterTags_A_fkey" FOREIGN KEY ("A") REFERENCES "Printer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PrinterTags" ADD CONSTRAINT "_PrinterTags_B_fkey" FOREIGN KEY ("B") REFERENCES "WorkspaceTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LibraryFileTags" ADD CONSTRAINT "_LibraryFileTags_A_fkey" FOREIGN KEY ("A") REFERENCES "LibraryFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LibraryFileTags" ADD CONSTRAINT "_LibraryFileTags_B_fkey" FOREIGN KEY ("B") REFERENCES "WorkspaceTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_SpoolTags" ADD CONSTRAINT "_SpoolTags_A_fkey" FOREIGN KEY ("A") REFERENCES "FilamentSpool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_SpoolTags" ADD CONSTRAINT "_SpoolTags_B_fkey" FOREIGN KEY ("B") REFERENCES "WorkspaceTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

