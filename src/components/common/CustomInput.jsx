import React from 'react';

const CustomInput = React.forwardRef(({
  type = 'text',
  disabled = false,
  className = '',
  style = {},
  error = false,
  ...props
}, ref) => {
  return (
    <input
      ref={ref}
      type={type}
      disabled={disabled}
      className={`custom-input-field ${error ? 'error' : ''} ${className}`}
      style={style}
      {...props}
    />
  );
});

CustomInput.displayName = 'CustomInput';

export default CustomInput;
