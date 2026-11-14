BEGIN;

CREATE TABLE IF NOT EXISTS public.stream_profiles (
    id uuid PRIMARY KEY,
    token_hash text NOT NULL UNIQUE,
    pseudo varchar(32) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE public.videos ADD COLUMN IF NOT EXISTS auteur_id uuid
    REFERENCES public.stream_profiles(id) ON DELETE SET NULL;
ALTER TABLE public.videos ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE public.videos ADD COLUMN IF NOT EXISTS chemin_affiche text;

CREATE TABLE IF NOT EXISTS public.video_likes (
    video_id uuid NOT NULL REFERENCES public.videos(id) ON DELETE CASCADE,
    profile_id uuid NOT NULL REFERENCES public.stream_profiles(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (video_id, profile_id)
);

CREATE TABLE IF NOT EXISTS public.video_saves (
    video_id uuid NOT NULL REFERENCES public.videos(id) ON DELETE CASCADE,
    profile_id uuid NOT NULL REFERENCES public.stream_profiles(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (video_id, profile_id)
);

CREATE TABLE IF NOT EXISTS public.video_shares (
    video_id uuid NOT NULL REFERENCES public.videos(id) ON DELETE CASCADE,
    profile_id uuid NOT NULL REFERENCES public.stream_profiles(id) ON DELETE CASCADE,
    event_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (video_id, profile_id, event_id)
);

CREATE TABLE IF NOT EXISTS public.video_comments (
    id uuid PRIMARY KEY,
    video_id uuid NOT NULL REFERENCES public.videos(id) ON DELETE CASCADE,
    profile_id uuid NOT NULL REFERENCES public.stream_profiles(id) ON DELETE CASCADE,
    parent_id uuid,
    reply_to_id uuid REFERENCES public.video_comments(id) ON DELETE SET NULL,
    texte varchar(1000) NOT NULL CHECK (length(trim(texte)) > 0),
    created_at timestamptz NOT NULL DEFAULT NOW(),
    UNIQUE (id, video_id),
    FOREIGN KEY (parent_id, video_id)
        REFERENCES public.video_comments(id, video_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS video_comments_feed_idx
    ON public.video_comments (video_id, created_at DESC, id DESC) WHERE parent_id IS NULL;
CREATE INDEX IF NOT EXISTS video_comments_replies_idx
    ON public.video_comments (parent_id, created_at, id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS video_comments_profile_idx ON public.video_comments (profile_id, created_at);

CREATE TABLE IF NOT EXISTS public.comment_likes (
    comment_id uuid NOT NULL REFERENCES public.video_comments(id) ON DELETE CASCADE,
    profile_id uuid NOT NULL REFERENCES public.stream_profiles(id) ON DELETE CASCADE,
    PRIMARY KEY (comment_id, profile_id)
);

-- Le compte de l'application reçoit seulement les droits d'utilisation des données.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stream_profiles,
    public.video_likes, public.video_saves, public.video_shares,
    public.video_comments, public.comment_likes TO streamingvideo_app;

COMMIT;
