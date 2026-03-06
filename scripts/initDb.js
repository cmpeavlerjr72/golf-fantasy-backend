require('dotenv').config();
const supabase = require('../config/supabase');

async function init() {
  try {
    // Test connection by querying the users table
    const { error } = await supabase.from('users').select('id').limit(1);

    if (error) {
      console.error('Connection test failed:', error.message);
      console.log('\nMake sure you have created the tables via the Supabase SQL Editor.');
    } else {
      console.log('Connected to Supabase successfully!');
      console.log('Tables are ready.');
    }
  } catch (err) {
    console.error('Error:', err);
  }
}

init();
