-- What an import knows about the file it read, without keeping the file.
--
-- The plan asks for the raw file to be archived (§8.2, step 1). This keeps
-- three facts about it instead, and that is a deliberate departure.
--
-- A bank statement is the most sensitive document this application handles: an
-- IBAN, an account holder's name, and every operation of the period - including
-- the ones nobody imported, the ones they unticked, and the ones belonging to
-- an account they do not track. Storing it makes a second copy of exactly that,
-- and a copy has to be encrypted at rest, backed up, purged, exported and
-- deleted on request. The reason given for keeping it - replaying an import
-- after a reading bug is fixed - is already served by rolling the run back and
-- importing the file again, which people still have.
--
-- What is left is what a person actually asks: "have I already imported this?"
-- A digest answers it and holds nothing.
ALTER TABLE imports
  -- sha256 over the decoded text, not the bytes. Decoding removes a byte order
  -- mark and settles the encoding, so the same statement saved twice by the
  -- same bank digests the same even when the files differ by a byte.
  ADD COLUMN file_hash text,
  ADD COLUMN file_bytes integer,
  ADD COLUMN file_lines integer;
--> statement-breakpoint

-- Not unique: importing the same file twice is allowed, and deduplication is
-- what stops it adding anything. This index is for looking one up.
CREATE INDEX imports_file_hash_idx ON imports (household_id, file_hash);
