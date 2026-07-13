import React from 'react';
import CustomInput from '../common/CustomInput';
import { Loader2 } from 'lucide-react';
import DeltaCredentialsSection from './DeltaCredentialsSection';

export default function EditAccountModal({
  isOpen,
  onClose,
  onSubmit,
  register,
  errors,
  isSaving,
  watch,
  setValue,
  credentialsMeta
}) {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay-wrapper">
      <form onSubmit={onSubmit} className="modal-form-edit">
        <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: 'var(--text)' }}>Edit Account Details</h3>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-dim)' }}>Account Name</label>
          <CustomInput
            type="text"
            error={!!errors.name}
            {...register('name', {
              required: 'Account name is required',
              validate: value => value.trim() !== '' || 'Account name cannot be empty'
            })}
            style={{
              padding: '8px 12px',
              borderRadius: '6px',
              fontSize: '13px',
              outline: 'none'
            }}
          />
          {errors.name && (
            <span style={{ fontSize: '11px', color: '#f85149', marginTop: '2px' }}>
              {errors.name.message}
            </span>
          )}
        </div>

        {watch && setValue && (
          <DeltaCredentialsSection
            register={register}
            watch={watch}
            setValue={setValue}
            existingMeta={credentialsMeta}
          />
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' }}>
          <button
            type="button"
            disabled={isSaving}
            onClick={onClose}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text)',
              cursor: isSaving ? 'not-allowed' : 'pointer',
              fontSize: '13px',
              fontWeight: 500,
              opacity: isSaving ? 0.6 : 1
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSaving}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: 'none',
              background: '#0969da',
              color: '#ffffff',
              cursor: isSaving ? 'not-allowed' : 'pointer',
              fontSize: '13px',
              fontWeight: 500,
              opacity: isSaving ? 0.8 : 1,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px'
            }}
          >
            {isSaving ? (
              <>
                 <Loader2 size={14} className="animate-spin" strokeWidth={3} />
                Saving...
              </>
            ) : 'Save Changes'}
          </button>
        </div>
      </form>
    </div>
  );
}
