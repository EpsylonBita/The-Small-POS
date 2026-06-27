import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { DeliveryValidationComponent } from '../components/delivery/DeliveryValidationComponent';
import { DeliveryBoundaryValidationResponse } from '../../shared/types/delivery-validation';
import { pageMotionContainer, pageMotionItem } from '../components/ui/page-motion';

export function DeliveryValidationTestPage() {
  const [validationResult, setValidationResult] = useState<DeliveryBoundaryValidationResponse | null>(null);
  const [address, setAddress] = useState('');
  const [coordinates, setCoordinates] = useState<{ lat: number; lng: number } | undefined>();
  const [orderAmount, setOrderAmount] = useState(25);
  const [staffRole, setStaffRole] = useState<'staff' | 'manager' | 'admin'>('staff');

  const handleValidationResult = (result: DeliveryBoundaryValidationResponse) => {
    setValidationResult(result);
    console.log('Validation Result:', result);
  };

  const handleAddressChange = (newAddress: string, newCoordinates?: { lat: number; lng: number }) => {
    setAddress(newAddress);
    setCoordinates(newCoordinates);
  };

  // Test addresses for Thessaloniki
  const testAddresses = [
    {
      name: 'City Center (Should be valid)',
      address: 'Aristotelous Square, Thessaloniki, Greece',
      coordinates: { lat: 40.6401, lng: 22.9444 }
    },
    {
      name: 'Residential Area (Should be valid)',
      address: 'Kalamaria, Thessaloniki, Greece',
      coordinates: { lat: 40.5801, lng: 22.9594 }
    },
    {
      name: 'Outside Zone (Should require override)',
      address: 'Perea, Thessaloniki, Greece',
      coordinates: { lat: 40.5001, lng: 22.9194 }
    },
    {
      name: 'Far Outside (Should require override)',
      address: 'Chalkidiki, Greece',
      coordinates: { lat: 40.2001, lng: 23.3194 }
    }
  ];

  const loadTestAddress = (testAddr: typeof testAddresses[0]) => {
    setAddress(testAddr.address);
    setCoordinates(testAddr.coordinates);
    // Trigger validation by updating the component
    setValidationResult(null);
  };

  return (
    <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className="min-h-screen bg-black p-6">
      <motion.div variants={pageMotionContainer} className="max-w-4xl mx-auto">
        <motion.h1 variants={pageMotionItem} className="text-3xl font-bold text-white mb-8 text-center">
          Delivery Zone Boundary Validation Test
        </motion.h1>

        {/* Test Controls */}
        <motion.div variants={pageMotionItem} className="bg-white/10 backdrop-blur-sm rounded-2xl p-6 mb-6">
          <h2 className="text-xl font-semibold text-white mb-4">Test Controls</h2>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div>
              <label className="block text-sm font-medium text-white/90 mb-2">
                Order Amount (EUR)
              </label>
              <input
                type="number"
                value={orderAmount}
                onChange={(e) => setOrderAmount(Number(e.target.value))}
                className="w-full p-2 bg-white/10 border border-white/20 rounded-2xl text-white"
                min="0"
                step="0.50"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-white/90 mb-2">
                Staff Role
              </label>
              <select
                value={staffRole}
                onChange={(e) => setStaffRole(e.target.value as 'staff' | 'manager' | 'admin')}
                className="w-full p-2 bg-white/10 border border-white/20 rounded-2xl text-white"
              >
                <option value="staff">Staff</option>
                <option value="manager">Manager</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-white/90 mb-2">
                Current Address
              </label>
              <div className="text-sm text-white/70 p-2 bg-white/5 rounded-2xl">
                {address || 'No address entered'}
              </div>
            </div>
          </div>

          {/* Test Address Buttons */}
          <div>
            <label className="block text-sm font-medium text-white/90 mb-2">
              Quick Test Addresses
            </label>
            <motion.div variants={pageMotionContainer} className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {testAddresses.map((testAddr, index) => (
                <motion.button
                  variants={pageMotionItem}
                  key={index}
                  onClick={() => loadTestAddress(testAddr)}
                  className="p-3 bg-amber-500/15 active:bg-amber-500/25 border border-amber-400/30 rounded-2xl text-white text-left transition-transform active:scale-[0.98]"
                >
                  <div className="font-medium">{testAddr.name}</div>
                  <div className="text-sm text-white/70">{testAddr.address}</div>
                  <div className="text-xs text-white/50">
                    {testAddr.coordinates.lat}, {testAddr.coordinates.lng}
                  </div>
                </motion.button>
              ))}
            </motion.div>
          </div>
        </motion.div>

        {/* Delivery Validation Component */}
        <motion.div variants={pageMotionItem} className="bg-white/10 backdrop-blur-sm rounded-2xl p-6 mb-6">
          <h2 className="text-xl font-semibold text-white mb-4">Delivery Validation</h2>
          
          <DeliveryValidationComponent
            orderAmount={orderAmount}
            onValidationResult={handleValidationResult}
            onAddressChange={handleAddressChange}
            staffId={`test_${staffRole}`}
            staffRole={staffRole}
            className="bg-white/5 border border-white/10 rounded-2xl p-4"
          />
        </motion.div>

        {/* Validation Results */}
        {validationResult && (
          <motion.div variants={pageMotionItem} className="bg-white/10 backdrop-blur-sm rounded-2xl p-6">
            <h2 className="text-xl font-semibold text-white mb-4">Validation Results</h2>
            
            <div className="space-y-4">
              {/* Status */}
              <div className="flex items-center gap-3">
                <span className="text-white/70">Status:</span>
                <span className={`px-3 py-1 rounded-full text-sm font-medium ${
                  validationResult.deliveryAvailable 
                    ? 'bg-green-600/20 text-green-400 border border-green-400/30'
                    : 'bg-red-600/20 text-red-400 border border-red-400/30'
                }`}>
                  {validationResult.deliveryAvailable ? 'Available' : 'Not Available'}
                </span>
                
                {validationResult.override?.applied && (
                  <span className="px-3 py-1 rounded-full text-sm font-medium bg-orange-600/20 text-orange-400 border border-orange-400/30">
                    Override Applied
                  </span>
                )}
              </div>

              {/* Message */}
              {validationResult.message && (
                <div>
                  <span className="text-white/70">Message:</span>
                  <div className="mt-1 p-3 bg-white/5 rounded-2xl text-white/90">
                    {validationResult.message}
                  </div>
                </div>
              )}

              {/* Zone Information */}
              {validationResult.zone && (
                <div>
                  <span className="text-white/70">Delivery Zone:</span>
                  <div className="mt-1 p-3 bg-white/5 rounded-2xl">
                    <div className="grid grid-cols-2 gap-4 text-sm text-white/90">
                      <div>Name: {validationResult.zone.name}</div>
                      <div>Fee: {validationResult.zone.deliveryFee} EUR</div>
                      <div>Minimum Order: {validationResult.zone.minimumOrderAmount} EUR</div>
                      <div>
                        Est. Time: {validationResult.zone.estimatedTime.min}-{validationResult.zone.estimatedTime.max} min
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Validation Details */}
              {validationResult.validation && (
                <div>
                  <span className="text-white/70">Order Validation:</span>
                  <div className="mt-1 p-3 bg-white/5 rounded-2xl">
                    <div className="grid grid-cols-2 gap-4 text-sm text-white/90">
                      <div>Order Amount: {validationResult.validation.orderAmount} EUR</div>
                      <div>Estimated Total: {validationResult.validation.estimatedTotal} EUR</div>
                      <div>Meets Minimum: {validationResult.validation.meetsMinimumOrder ? 'Yes' : 'No'}</div>
                      {validationResult.validation.shortfall > 0 && (
                        <div>Shortfall: {validationResult.validation.shortfall} EUR</div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Coordinates */}
              {validationResult.coordinates && (
                <div>
                  <span className="text-white/70">Coordinates:</span>
                  <div className="mt-1 p-3 bg-white/5 rounded-2xl text-white/90 font-mono text-sm">
                    {validationResult.coordinates.lat}, {validationResult.coordinates.lng}
                  </div>
                </div>
              )}

              {/* Raw JSON */}
              <details className="mt-4">
                <summary className="text-white/70 cursor-pointer active:text-white">
                  Raw Validation Response (Click to expand)
                </summary>
                <pre className="mt-2 p-3 bg-black/20 rounded-2xl text-xs text-white/80 overflow-auto scrollbar-hide">
                  {JSON.stringify(validationResult, null, 2)}
                </pre>
              </details>
            </div>
          </motion.div>
        )}

        {/* Instructions */}
        <motion.div variants={pageMotionItem} className="bg-white/10 backdrop-blur-sm rounded-2xl p-6 mt-6">
          <h2 className="text-xl font-semibold text-white mb-4">Testing Instructions</h2>
          <div className="space-y-2 text-white/80">
            <p>1. <strong>Test Valid Addresses:</strong> Use "City Center" or "Residential Area" buttons to test addresses within delivery zones.</p>
            <p>2. <strong>Test Invalid Addresses:</strong> Use "Outside Zone" or "Far Outside" buttons to test addresses requiring overrides.</p>
            <p>3. <strong>Test Staff Roles:</strong> Change staff role to see different override permissions (Staff requires manager approval, Manager/Admin can override directly).</p>
            <p>4. <strong>Test Order Amounts:</strong> Adjust order amount to test minimum order validation.</p>
            <p>5. <strong>Test Manual Entry:</strong> Type addresses manually to test real-time validation.</p>
            <p>6. <strong>Test Override:</strong> When validation fails, use the override button to test bypass functionality.</p>
          </div>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}
