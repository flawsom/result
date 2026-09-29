// NOTE: analytics v2 additions (analytics_events.outcome/latency_ms/attempt/
// source/subjects, the analytics_live counter row, get_results_analytics_v2 and
// log_result_events) are declared by hand here because the project has no
// linked Supabase instance to run `supabase gen types` against. Regenerate this
// file from the dashboard once the project is reachable — the shapes match the
// migration in supabase/migrations/20260928120000_analytics_v2.sql exactly.
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      analytics_events: {
        Row: {
          attempt: number | null
          branch: string
          id: number
          latency_ms: number | null
          outcome: string | null
          semester: number
          served_at: string
          source: string | null
          subjects: number | null
          year: number
        }
        Insert: {
          attempt?: number | null
          branch: string
          id?: number
          latency_ms?: number | null
          outcome?: string | null
          semester: number
          served_at?: string
          source?: string | null
          subjects?: number | null
          year: number
        }
        Update: {
          attempt?: number | null
          branch?: string
          id?: number
          latency_ms?: number | null
          outcome?: string | null
          semester?: number
          served_at?: string
          source?: string | null
          subjects?: number | null
          year?: number
        }
        Relationships: []
      }
      analytics_live: {
        Row: {
          events: number
          id: number
          last_latency_ms: number | null
          last_outcome: string | null
          last_semester: number | null
          last_year: number | null
          updated_at: string
        }
        Insert: {
          events?: number
          id?: number
          last_latency_ms?: number | null
          last_outcome?: string | null
          last_semester?: number | null
          last_year?: number | null
          updated_at?: string
        }
        Update: {
          events?: number
          id?: number
          last_latency_ms?: number | null
          last_outcome?: string | null
          last_semester?: number | null
          last_year?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      analytics_seed: {
        Row: {
          branch: string
          count: number
          semester: number
          year: number
        }
        Insert: {
          branch: string
          count: number
          semester: number
          year: number
        }
        Update: {
          branch?: string
          count?: number
          semester?: number
          year?: number
        }
        Relationships: []
      }
      bput_census_cursor: {
        Row: {
          facts: number
          id: number
          next_index: number
          not_found: number
          range_end: string
          range_start: string
          started_at: string
          status: string
          updated_at: string
          visited: number
        }
        Insert: {
          facts?: number
          id?: number
          next_index?: number
          not_found?: number
          range_end: string
          range_start: string
          started_at?: string
          status?: string
          updated_at?: string
          visited?: number
        }
        Update: {
          facts?: number
          id?: number
          next_index?: number
          not_found?: number
          range_end?: string
          range_start?: string
          started_at?: string
          status?: string
          updated_at?: string
          visited?: number
        }
        Relationships: []
      }
      bput_census_events: {
        Row: {
          batch_year: number
          branch: string
          college: string
          credits: number
          grades: Json
          id: number
          outcome: string
          points: number
          semester: number
          served_at: string
          subjects: number
        }
        Insert: {
          batch_year: number
          branch: string
          college?: string
          credits?: number
          grades?: Json
          id?: number
          outcome: string
          points?: number
          semester: number
          served_at?: string
          subjects?: number
        }
        Update: {
          batch_year?: number
          branch?: string
          college?: string
          credits?: number
          grades?: Json
          id?: number
          outcome?: string
          points?: number
          semester?: number
          served_at?: string
          subjects?: number
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_results_analytics: { Args: never; Returns: Json }
      get_results_analytics_v2: { Args: never; Returns: Json }
      log_result_events: { Args: { _events: Json }; Returns: number }
      census_can_write: { Args: never; Returns: boolean }
      census_cursor_state: {
        Args: { _range_end: string; _range_start: string }
        Returns: Json
      }
      census_cursor_upsert: {
        Args: {
          _facts_add: number
          _next_index: number
          _not_found_add: number
          _range_end: string
          _range_start: string
          _status: string
          _visited_add: number
        }
        Returns: number
      }
      census_progress: { Args: never; Returns: Json }
      // Declared by hand for the same reason as the v2 block above: the
      // maintenance ledger is created by
      // supabase/migrations/20260929193000_census_maintenance.sql, and there is
      // no linked instance to regenerate against.
      census_plan: { Args: never; Returns: Json }
      census_note_blocks: { Args: { _rows: Json }; Returns: number }
      census_note_watch: { Args: { _rows: Json }; Returns: number }
      census_note_walk: {
        Args: {
          _captured: number[]
          _code: number
          _completed: boolean
          _frontier: number
          _offset: number
          _year: number
        }
        Returns: boolean
      }
      // True when the pass is ours to read; false when it is already captured or
      // still in flight.
      census_claim_pass: {
        Args: { _code: number; _semester: number; _year: number }
        Returns: boolean
      }
      census_report_pass: {
        Args: {
          _code: number
          _semester: number
          _status: string
          _subjects: number
          _year: number
        }
        Returns: boolean
      }
      // Replaces this block's rows for one semester in a single transaction: the
      // reason a re-read corrects the census instead of double-counting it.
      census_apply_pass: {
        Args: { _code: number; _rows: Json; _semester: number; _year: number }
        Returns: number
      }
      census_next_work: { Args: { _limit: number }; Returns: Json }
      get_bput_census: { Args: never; Returns: Json }
      log_census_events: { Args: { _rows: Json }; Returns: number }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      log_result_view: {
        Args: { _branch: string; _semester: number; _year: number }
        Returns: undefined
      }
    }
    Enums: {
      app_role: "admin" | "viewer"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "viewer"],
    },
  },
} as const
