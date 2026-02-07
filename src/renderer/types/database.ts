export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      app_configurations: {
        Row: {
          app_name: string
          applies_to_branch: string | null
          config_key: string
          config_value: Json
          created_at: string | null
          environment: string
          id: string
          is_active: boolean
          is_sensitive: boolean
          updated_at: string | null
          updated_by: string | null
          version: string | null
        }
        Insert: {
          app_name: string
          applies_to_branch?: string | null
          config_key: string
          config_value: Json
          created_at?: string | null
          environment?: string
          id?: string
          is_active?: boolean
          is_sensitive?: boolean
          updated_at?: string | null
          updated_by?: string | null
          version?: string | null
        }
        Update: {
          app_name?: string
          applies_to_branch?: string | null
          config_key?: string
          config_value?: Json
          created_at?: string | null
          environment?: string
          id?: string
          is_active?: boolean
          is_sensitive?: boolean
          updated_at?: string | null
          updated_by?: string | null
          version?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "app_configurations_applies_to_branch_fkey"
            columns: ["applies_to_branch"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          address: string | null
          created_at: string | null
          email: string | null
          id: string
          loyalty_points: number | null
          name: string | null
          notes: string | null
          phone: string | null
          postal_code: string | null
          ringer_name: string | null
          total_orders: number | null
          updated_at: string | null
        }
        Insert: {
          address?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          loyalty_points?: number | null
          name?: string | null
          notes?: string | null
          phone?: string | null
          postal_code?: string | null
          ringer_name?: string | null
          total_orders?: number | null
          updated_at?: string | null
        }
        Update: {
          address?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          loyalty_points?: number | null
          name?: string | null
          notes?: string | null
          phone?: string | null
          postal_code?: string | null
          ringer_name?: string | null
          total_orders?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      subcategories: {
        Row: {
          allergens: string[] | null
          category_id: string
          created_at: string | null
          description_el: string | null
          description_en: string | null
          display_order: number | null
          id: string
          image_url: string | null
          is_available: boolean | null
          name_el: string
          name_en: string
          preparation_time: number | null
          price: number
          updated_at: string | null
        }
        Insert: {
          allergens?: string[] | null
          category_id: string
          created_at?: string | null
          description_el?: string | null
          description_en?: string | null
          display_order?: number | null
          id?: string
          image_url?: string | null
          is_available?: boolean | null
          name_el: string
          name_en: string
          preparation_time?: number | null
          price: number
          updated_at?: string | null
        }
        Update: {
          allergens?: string[] | null
          category_id?: string
          created_at?: string | null
          description_el?: string | null
          description_en?: string | null
          display_order?: number | null
          id?: string
          image_url?: string | null
          is_available?: boolean | null
          name_el?: string
          name_en?: string
          preparation_time?: number | null
          price?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "subcategories_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
      menu_categories: {
        Row: {
          created_at: string | null
          description_el: string | null
          description_en: string | null
          display_order: number | null
          id: string
          is_active: boolean | null
          name_el: string
          name_en: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          description_el?: string | null
          description_en?: string | null
          display_order?: number | null
          id?: string
          is_active?: boolean | null
          name_el: string
          name_en: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          description_el?: string | null
          description_en?: string | null
          display_order?: number | null
          id?: string
          is_active?: boolean | null
          name_el?: string
          name_en?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      orders: {
        Row: {
          created_at: string | null
          customer_email: string | null
          customer_id: string | null
          customer_name: string | null
          customer_phone: string | null
          delivery_address: string | null
          discount_amount: number | null
          id: string
          local_id: number | null
          notes: string | null
          order_type: string
          payment_method: string | null
          payment_status: string | null
          staff_id: string | null
          status: string
          table_number: number | null
          tax_amount: number | null
          total_amount: number
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          customer_email?: string | null
          customer_id?: string | null
          customer_name?: string | null
          customer_phone?: string | null
          delivery_address?: string | null
          discount_amount?: number | null
          id?: string
          local_id?: number | null
          notes?: string | null
          order_type?: string
          payment_method?: string | null
          payment_status?: string | null
          staff_id?: string | null
          status?: string
          table_number?: number | null
          tax_amount?: number | null
          total_amount: number
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          customer_email?: string | null
          customer_id?: string | null
          customer_name?: string | null
          customer_phone?: string | null
          delivery_address?: string | null
          discount_amount?: number | null
          id?: string
          local_id?: number | null
          notes?: string | null
          order_type?: string
          payment_method?: string | null
          payment_status?: string | null
          staff_id?: string | null
          status?: string
          table_number?: number | null
          tax_amount?: number | null
          total_amount?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "orders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      order_items: {
        Row: {
          id: string
          order_id: string
          menu_item_id: string
          quantity: number
          unit_price: number
          total_price: number | null
          customizations: Json | null
          notes: string | null
          created_at: string | null
        }
        Insert: {
          id?: string
          order_id: string
          menu_item_id: string
          quantity: number
          unit_price: number
          total_price?: number | null
          customizations?: Json | null
          notes?: string | null
          created_at?: string | null
        }
        Update: {
          id?: string
          order_id?: string
          menu_item_id?: string
          quantity?: number
          unit_price?: number
          total_price?: number | null
          customizations?: Json | null
          notes?: string | null
          created_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "order_items_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "subcategories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_configurations: {
        Row: {
          branch_id: string | null
          config_key: string
          config_type: string
          config_value: Json
          created_at: string | null
          description: string | null
          id: string
          is_active: boolean
          last_sync_at: string | null
          sync_status: string
          terminal_id: string
          updated_at: string | null
          updated_by: string | null
        }
        Insert: {
          branch_id?: string | null
          config_key: string
          config_type: string
          config_value: Json
          created_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          last_sync_at?: string | null
          sync_status?: string
          terminal_id: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Update: {
          branch_id?: string | null
          config_key?: string
          config_type?: string
          config_value?: Json
          created_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          last_sync_at?: string | null
          sync_status?: string
          terminal_id?: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pos_configurations_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      restaurant_settings: {
        Row: {
          category: string
          created_at: string | null
          description: string | null
          id: string
          is_public: boolean
          requires_restart: boolean
          setting_key: string
          setting_type: string
          setting_value: Json
          updated_at: string | null
          updated_by: string | null
          validation_rules: Json | null
        }
        Insert: {
          category: string
          created_at?: string | null
          description?: string | null
          id?: string
          is_public?: boolean
          requires_restart?: boolean
          setting_key: string
          setting_type: string
          setting_value: Json
          updated_at?: string | null
          updated_by?: string | null
          validation_rules?: Json | null
        }
        Update: {
          category?: string
          created_at?: string | null
          description?: string | null
          id?: string
          is_public?: boolean
          requires_restart?: boolean
          setting_key?: string
          setting_type?: string
          setting_value?: Json
          updated_at?: string | null
          updated_by?: string | null
          validation_rules?: Json | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

export type Tables<
  PublicTableNameOrOptions extends
    | keyof (Database["public"]["Tables"] & Database["public"]["Views"])
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
        Database[PublicTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
      Database[PublicTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : PublicTableNameOrOptions extends keyof (Database["public"]["Tables"] &
        Database["public"]["Views"])
    ? (Database["public"]["Tables"] &
        Database["public"]["Views"])[PublicTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  PublicTableNameOrOptions extends
    | keyof Database["public"]["Tables"]
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : PublicTableNameOrOptions extends keyof Database["public"]["Tables"]
    ? Database["public"]["Tables"][PublicTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  PublicTableNameOrOptions extends
    | keyof Database["public"]["Tables"]
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : PublicTableNameOrOptions extends keyof Database["public"]["Tables"]
    ? Database["public"]["Tables"][PublicTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never