// Fill these in from Supabase → Project Settings → API
const SUPABASE_URL = "https://uydyxhpowawyioqxtfcm.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV5ZHl4aHBvd2F3eWlvcXh0ZmNtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA1MDExNjUsImV4cCI6MjEwNjA3NzE2NX0.IOzdQrAWMkjssIqqwXb9a5vvJyJTP4y4A7HjJUQ8y98";

// `supabase` global comes from the CDN script tag in index.html
export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
