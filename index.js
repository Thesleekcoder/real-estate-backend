const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Supabase Client using secure environment variables
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// MIDDLEWARE: Check Token Validity & Assign Identity Roles
const authorizeUser = (allowedRoles) => {
    return async (req, res, next) => {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Access Denied: Missing Authorization Token' });
        }

        const token = authHeader.split(' ')[1];
        const { data: { user }, error } = await supabase.auth.getUser(token);

        if (error || !user) {
            return res.status(401).json({ error: 'Access Denied: Invalid Session' });
        }

        // Pull tenant ID and role from secure user metadata
        const userTenantId = user.user_metadata.tenant_id;
        const userRole = user.user_metadata.role;

        req.userContext = {
            id: user.id,
            tenant_id: userTenantId,
            role: userRole
        };

        // Enforce structural access check
        if (!allowedRoles.includes(userRole) && !allowedRoles.includes('*')) {
            return res.status(403).json({ error: 'Access Denied: Your role does not allow this operation' });
        }

        next();
    };
};

// HEALTH CHECK ENDPOINT: Verify that Render is running smoothly
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'Online', timestamp: new Date() });
});

// ROUTE: Add New Asset Property (Admin & MD/CEO Only)
app.post('/api/properties', authorizeUser(['ADMIN', 'MD_CEO']), async (req, res) => {
    const { property_name, location, asset_type, layout_block_number, plot_number, square_meters, house_type, total_price } = req.body;
    const { tenant_id } = req.userContext;

    const { data, error } = await supabase
        .from('properties')
        .insert([{
            tenant_id, property_name, location, asset_type,
            layout_block_number, plot_number, square_meters, house_type, total_price
        }])
        .select();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ message: 'Property listed successfully', property: data[0] });
});

// ROUTE: Fetch Accountant's Transaction Ledger (Accountant & MD/CEO Only)
app.get('/api/transactions', authorizeUser(['ACCOUNTANT', 'MD_CEO']), async (req, res) => {
    const { tenant_id } = req.userContext;

    const { data, error } = await supabase
        .from('transactions')
        .select('*, customers(full_name), properties(property_name)')
        .eq('tenant_id', tenant_id)
        .order('transaction_date', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ledger: data });
});

// ROUTE: Update Construction Progress (Admin, Marketer, & CEO)
app.patch('/api/milestones/:id', authorizeUser(['ADMIN', 'MARKETER', 'MD_CEO']), async (req, res) => {
    const { id } = req.params;
    const { is_completed } = req.body;

    const { data, error } = await supabase
        .from('construction_milestones')
        .update({ is_completed, completed_at: is_completed ? new Date() : null })
        .eq('id', id)
        .select();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: 'Milestone updated', milestone: data[0] });
});

// Bind server to production port environment
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server executing seamlessly on port ${PORT}`));
